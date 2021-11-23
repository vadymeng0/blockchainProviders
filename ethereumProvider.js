import hdkey from 'ethereumjs-wallet/hdkey';
import EthTransaction from 'ethereumjs-tx';
import config from 'config';
import axios from 'axios';
import Big from 'big.js';
import Web3 from 'web3';
import R from 'ramda';

import commonProvider from 'coins/blockchainProviders/commonProvider';
import { toHashMap } from 'utils';

Big.NE = -10;

export default class extends commonProvider {
  paymentStrategy = 'consistently';

  constructor(coinName, nodeAddress, apiTxsUrl, hdPath) {
    super(coinName, nodeAddress);

    this.apiTxsUrl = apiTxsUrl;
    this.coinName = coinName;
    this.hdPath = hdPath;

    this.web3 = new Web3(nodeAddress);
  }

  /**
   * Address validity check.
   * @param {string} address
   * @returns {boolean}
   */
  isValidAddress(address) {
    return typeof address === 'string' && this.web3.utils.isAddress(address);
  }

  /**
   * Generate wallet from 12 words.
   * @param {string} mnemonic
   * @returns {Promise<{address: string, privateKey: string}>}
   */
  async generateWallet(mnemonic = this.generateMnemonic()) {
    const seed = this.generateSeed(mnemonic);

    const wallet = hdkey.fromMasterSeed(seed).derivePath(this.hdPath).getWallet();

    return {
      address: wallet.getAddressString().toLowerCase(),
      privateKey: wallet.getPrivateKeyString()
    };
  }

  /**
   * Get Balance by address.
   * @param {string} address - Ethereum Address.
   */
  async getBalance(address) {
    const { fromWei } = this.web3.utils;

    return axios({
      method: 'POST',
      url: this.nodeAddress,
      data: [{
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: [address, 'latest']
      }, {
        id: 2,
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: [address, 'pending']
      }]
    }).then(R.path(['data'])).then(R.pipe(
      data => ({
        confirmed: Big(fromWei(R.find(R.propEq('id', 1), data).result, 'ether').toString()),
        total: Big(fromWei(R.find(R.propEq('id', 2), data).result, 'ether').toString())
      }),
      balances => R.assoc('unconfirmed', balances.total.minus(balances.confirmed), balances)
    ));
  }

  /**
   * Is confirmed transaction by hash.
   * @param {string} hash - Transaction hash.
   * @returns {Promise<boolean>}
   */
  async isConfirmedTransactionByHash(hash) {
    const [tx, blockNumber] = await Promise.all([
      this.web3.eth.getTransactionReceipt(hash),
      this.web3.eth.getBlockNumber()
    ]);

    const countConfirmations = config.confirmations.ethereum;

    return tx && tx.status === true && blockNumber - tx.blockNumber >= countConfirmations;
  }

  /**
   * Get received transactions by address.
   * @param {string} address - Address
   * @returns {Promise<array<{
   *   confirmations: number,
   *   reserveAddress: string,
   *   fromAddress: string,
   *   amount: string,
   *   hash: string,
   *   fee: string
   * }>>}
   */
  async getReceivedTransactions(address) {
    const url = `${this.apiTxsUrl}?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=50&apikey=F4IZ2BNQ4B8VCIGEE7X42BFKQUFQ8CY8WF`;
    const reserveAddress = address.toLowerCase();

    const { data: { result: transactions } } = await axios.get(url);

    if (transactions === null) return [];

    return transactions
      .filter(R.allPass([
        R.propEq('input', '0x'),
        R.propSatisfies(R.pipe(
          R.toLower,
          R.equals(reserveAddress)
        ), 'to')
      ]))
      .map(tx => ({
        reserveId: this.reserveWalletIds[tx.to],
        fromAddress: tx.from.toLowerCase(),
        reserveAddress,
        amount: Big(tx.value).div('1000000000000000000').toString(),
        fee: Big(tx.gasPrice).times('0.000000000000021').toString(),
        confirmations: parseInt(tx.confirmations, 10),
        hash: tx.hash.toLowerCase()
      }));
  }

  /**
   * Get all received transactions in reserves.
   * @returns {Promise<array<{
   *   confirmations: number,
   *   reserveAddress: string,
   *   fromAddress: string,
   *   amount: string,
   *   hash: string,
   *   fee: string
   * }>>}
   */
  async getReceivedReservesTransactions() {
    return Promise
      .all(this.reserveWallets.map(({ address }) => this.getReceivedTransactions(address)))
      .then(R.flatten);
  }

  /**
   * Get reserve with spent balances.
   * @param {array<{address: string, privateKey: string}>} wallets
   * @param spentBalances
   * @returns {Promise<array<{address: string, balance: Big, privateKey: string}>>}
   */
  async getReserveWithSpentBalances(wallets, spentBalances) {
    return Promise.all(wallets.map(async (wallet) => {
      const balance = await this.getBalance(wallet.address).then(R.prop('confirmed'));

      return R.assoc(
        'balance',
        spentBalances[wallet.address]
          ? balance.minus(spentBalances[wallet.address])
          : balance,
        wallet
      );
    }));
  }

  /**
   * Prepare payment.
   * @param {array<{address: string, amount: number}>} toAddresses
   * @param {array<{
   *   address: string,
   *   balance: string | number
   * }>} spentBalances
   * @returns {Promise<{
   *   fee: string,
   *   prepareData: {
   *     gasPrice: number
   *   },
   *   failedTransactions: array<{
   *     id: string,
   *     amount: string
   *     toAddress: string,
   *   }>,
   *   successTransactions: array<{
   *     wallet: {
   *       address: string,
   *       privateKey: string
   *     },
   *     id: string,
   *     amount: string
   *     toAddress: string,
   *   }>
   * }>}
   */
  async preparePayment(toAddresses, spentBalances = []) {
    const wallets = this.reserveWallets;

    const spentBalancesHashMap = toHashMap(spentBalances, 'address', 'balance');

    const [reserves, gasPrice] = await Promise.all([
      this.getReserveWithSpentBalances(wallets, spentBalancesHashMap),
      this.web3.eth.getGasPrice()
    ]);

    // 0.000000000000021 = 21000 / 1e18
    const fee = Big(gasPrice).times('0.000000000000021').toString();

    const toAddressesWithFee = toAddresses.map(R.assoc('fee', fee));

    const walletsHashMap = await Promise.all(wallets.map(async ({ address }) => [address, {
      nonce: await this.web3.eth.getTransactionCount(address, 'pending')
    }]));

    const {
      failedTransactions,
      successTransactions
    } = this.walletsSelect(reserves, toAddressesWithFee);

    return {
      fee,
      prepareData: {
        gasPrice,
        wallets: R.fromPairs(walletsHashMap)
      },
      failedTransactions,
      successTransactions: successTransactions.map(tx => R.assoc('amount', Big(tx.amount).minus(fee).toString(), tx))
    };
  }

  /**
   * Sign transaction.
   * @param {{address: string, privateKey: string}} wallet
   * @param {string} toAddress
   * @param {number} amount
   * @param {{
   *   nonce: number,
   *   gasPrice: number
   * }} data
   * @returns {Promise<{
   *   hash: string,
   *   data: {
   *     wallets: {}
   *   },
   *   signedTransaction: string
   * }>}
   */
  async signTransaction(wallet, toAddress, amount, data) {
    const { gasPrice, wallets } = data;
    const { nonce } = wallets[wallet.address];

    const { toHex, toWei } = this.web3.utils;

    const tx = new EthTransaction({
      nonce: toHex(nonce),
      gasPrice: toHex(gasPrice),

      value: toHex(toWei(amount, 'ether')),

      to: toAddress,

      gas: '0x5208' // 21000
    });

    tx.sign(Buffer.from(wallet.privateKey.slice(2), 'hex'));

    const hash = `0x${tx.hash().toString('hex').toLowerCase()}`;
    const signedTransaction = `0x${tx.serialize().toString('hex')}`;

    return {
      hash,
      data: {
        wallets: R.assocPath([wallet.address, 'nonce'], nonce + 1, wallets)
      },
      signedTransaction
    };
  }

  /**
   * Send signed transaction
   * @param {string} signedTransaction
   * @returns {Promise<string>} transaction hash
   */
  async sendSignedTransaction(signedTransaction) {
    return axios({
      method: 'POST',
      url: this.nodeAddress,
      data: {
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_sendRawTransaction',
        params: [signedTransaction]
      }
    }).then(R.path(['data', 'result']));
  }
}