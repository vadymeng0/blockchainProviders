import WAValidator from 'wallet-address-validator';
import bitcoinjs from 'bitcoinjs-lib';
import config from 'config';
import axios from 'axios';
import Big from 'big.js';
import R from 'ramda';

import commonProvider from 'coins/blockchainProviders/commonProvider';
import { toHashMap } from 'utils';

Big.NE = -10;

export default class extends commonProvider {
  paymentStrategy = 'batch';

  constructor(coinName, nodeAddress, networkType, network, hdPath) {
    super(coinName, nodeAddress);

    this.networkType = networkType;
    this.network = network;
    this.hdPath = hdPath;
  }

  /**
   * Address validity check.
   * @param {string} address
   * @returns {boolean}
   */
  isValidAddress(address) {
    return typeof address === 'string' && WAValidator.validate(address, this.coinName, this.networkType);
  }

  /**
   * Get unspent outputs.
   * @param {string} address
   */
  async getUnspentOutputs(address) {
    return axios.get(`${this.nodeAddress}addr/${address}/utxo`)
      .then(({ data }) => data);
  }

  /**
   * Get estimate fee
   * @param {number|string} blocks
   */
  async getEstimateFee(blocks) {
    const { data } = await axios.get(`${this.nodeAddress}utils/estimatefee?nbBlocks=${blocks}`);
    const estimateFee = Math.round((data[blocks] * 1e8) / 1024);

    return estimateFee > 2 ? estimateFee : 2;
  }

  /**
   * Generate wallet from 12 words.
   * @param {string} mnemonic
   * @returns {Promise<{address: string, privateKey: string}>}
   */
  async generateWallet(mnemonic = this.generateMnemonic()) {
    const seed = this.generateSeed(mnemonic);

    const { fromSeedBuffer } = bitcoinjs.HDNode;
    const { keyPair } = fromSeedBuffer(seed, this.network).derivePath(this.hdPath);
    const address = keyPair.getAddress();
    const privateKey = keyPair.toWIF();

    return {
      address,
      privateKey
    };
  }

  /**
   * Get Balance by address.
   * @param {string} address - Address.
   */
  async getBalance(address) {
    const url = `${this.nodeAddress}addr/${address}?notxlist=1`;

    const { data: { balance, unconfirmedBalance } } = await axios.get(url);

    const confirmed = new Big(balance);
    const unconfirmed = new Big(unconfirmedBalance);
    const total = confirmed.plus(unconfirmed);

    return {
      total,
      confirmed,
      unconfirmed
    };
  }

  /**
   * Is confirmed transaction by hash.
   * @param {string} hash - Transaction hash.
   * @returns {Promise<boolean>}
   */
  async isConfirmedTransactionByHash(hash) {
    const url = `${this.nodeAddress}tx/${hash}`;

    return axios.get(url)
      .then(R.pathSatisfies(
        R.lte(config.confirmations.bitcoin),
        ['data', 'confirmations']
      ));
  }

  /**
   * Get received transactions by address.
   * @param {string} reserveAddress - Address
   * @returns {Promise<array<{
   *   confirmations: number,
   *   reserveAddress: string,
   *   fromAddress: string,
   *   amount: string,
   *   hash: string,
   *   fee: string
   * }>>}
   */
  async getReceivedTransactions(reserveAddress) {
    const url = `${this.nodeAddress}txs/?address=${reserveAddress}&pageNum=`;
    const countPages = 3;

    return R.pipeP(
      async pageCount => R.times(R.pipe(R.toString, R.concat(url)), pageCount),
      R.map(axios.get),
      promises => Promise.all(promises),
      R.map(R.path(['data', 'txs'])),
      R.flatten,
      R.uniqBy(R.prop('txid')),
      R.filter((tx) => {
        const inputAddrHM = toHashMap(tx.vin, 'addr', true);

        if (inputAddrHM[reserveAddress] || R.keys(inputAddrHM).length !== 1) return false;

        // eslint-disable-next-line
        for (const out of tx.vout) {
          const addresses = R.path(['scriptPubKey', 'addresses'], out);
          if (!addresses || addresses.length !== 1) return false;
        }
        return true;
      }),
      R.map((tx) => {
        const amount = tx.vout.reduce(
          (value, input) => (input.scriptPubKey.addresses[0] === reserveAddress
            ? value.plus(input.value)
            : value
          ),
          Big(0)
        ).toString();

        const valueIn = tx.vin.reduce((value, input) => value.plus(input.value), Big(0));
        const valueOut = tx.vout.reduce((value, input) => value.plus(input.value), Big(0));

        const fromAddress = tx.vin[0].addr;

        const fee = valueIn.minus(valueOut).toString();
        const confirmations = parseInt(tx.confirmations, 10);
        const hash = tx.txid;

        return {
          fromAddress,
          reserveAddress,
          amount,
          fee,
          confirmations,
          hash
        };
      })
    )(countPages);
  }

  /**
   * Prepare payment.
   * @param {array<{address: string, amount: number, id: string}>} toAddresses
   * @param {array<{
   *   txid: string,
   *   vout: number
   * }>} spentOutputs
   * @returns {Promise<{
   *   failedTransactions: array<{
   *     toAddress: string,
   *     amount: string,
   *     id: string
   *   }>,
   *   successTransactions: array<{
   *     toAddress: string,
   *     amount: string,
   *     id: string
   *   }>,
   *   inputs: array,
   *   outputs: array,
   *   userFee: string
   * }>}
   */
  async preparePayment(toAddresses, spentOutputs = []) {
    const wallets = this.reserveWallets;

    const [utxo, feeRate] = await Promise.all([
      Promise.all(wallets.map(({ address }) => this.getUnspentOutputs(address))).then(R.flatten),
      this.getEstimateFee(2)
    ]);

    const spentOutputsHashMap = toHashMap(spentOutputs);

    const transactions = R.sort((a, b) => (a.amount > b.amount ? 1 : -1), toAddresses)
      .map(({ address, amount, id }) => ({
        id,
        amount,
        toAddress: address,
        value: parseInt(new Big(amount).times(1e8).round(0, 0).toString(), 10)
      }));

    const transformedUtxo = R.pipe(
      R.filter(({ confirmations, txid, vout }) => confirmations > 0 && !spentOutputsHashMap[`${txid}${vout}`]),
      R.map(output => R.assoc('value', output.satoshis, output))
    )(utxo);

    return this.coinSelect(transformedUtxo, transactions, feeRate);
  }

  /**
   * Sign transaction.
   * @param {array} inputs
   * @param {array} outputs
   * @returns {Promise<{
   *   fee: string,
   *   hash: string,
   *   signedTransaction: string
   * }>}
   */
  async signTransaction(inputs, outputs) {
    const wallets = this.reserveWallets;

    const pairs = R.pipe(
      R.map(({ address, privateKey }) => [
        address,
        bitcoinjs.ECPair.fromWIF(privateKey, this.network)
      ]),
      R.fromPairs
    )(wallets);

    const valueIn = R.reduce((value, input) => value.plus(input.value), Big(0), inputs);
    const fee = R.pipe(
      R.reduce((value, output) => value.minus(output.value), valueIn),
      feeInSatoshis => feeInSatoshis.div(1e8).toString()
    )(outputs);

    const txBuilder = new bitcoinjs.TransactionBuilder(this.network, 0);

    inputs.forEach(({ txid, vout }) => {
      txBuilder.addInput(txid, vout);
    });
    outputs.forEach(({ toAddress, value }) => {
      txBuilder.addOutput(toAddress || wallets[0].address, value);
    });

    inputs.forEach(({ address }, i) => txBuilder.sign(i, pairs[address]));

    const tx = txBuilder.build();

    const hash = tx.getId();
    const signedTransaction = tx.toHex();

    return {
      fee,
      hash,
      signedTransaction
    };
  }

  /**
   * Send signed transaction
   * @param {string} signedTransaction
   * @returns {Promise<string>} transaction hash
   */
  async sendSignedTransaction(signedTransaction) {
    return axios.post(`${this.nodeAddress}tx/send`, {
      rawtx: signedTransaction
    }).then(R.path(['data', 'txid']));
  }
}