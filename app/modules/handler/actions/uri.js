import { find } from 'lodash';

import * as types from '../../../shared/actions/types';
import eos from '../../../shared/actions/helpers/eos';
import { httpClient } from '../../../shared/utils/httpClient';

const { SigningRequest } = require('eosio-uri');
const zlib = require('zlib');

export function broadcastURI(tx, blockchain, callback = false) {
  return (dispatch: () => void, getState) => {
    dispatch({
      type: types.SYSTEM_EOSIOURIBROADCAST_PENDING
    });
    const {
      connection
    } = getState();
    const modified = Object.assign({}, connection, {
      broadcast: false,
      chainId: blockchain.chainId,
      httpEndpoint: blockchain.node
    });
    eos(modified)
      .pushTransaction(tx.transaction).then((response) => {
        console.log(response)
        if (callback) {
          dispatch(callbackURIWithProcessed({
            bi: response.processed.id,
            bn: response.processed.block_num,
            tx: response.transaction_id,
            sig: tx.transaction.signatures
          }, callback));
        }
        return dispatch({
          payload: { response },
          type: types.SYSTEM_EOSIOURIBROADCAST_SUCCESS
        });
      })
      .catch((err) => dispatch({
        payload: { err },
        type: types.SYSTEM_EOSIOURIBROADCAST_FAILURE
      }));
  };
}

export function callbackURIWithProcessed({ bi, bn, tx, sig }, callback) {
  return (dispatch: () => void, getState) => {
    const { settings } = getState();
    dispatch({
      type: types.SYSTEM_EOSIOURICALLBACK_PENDING
    });
    const {
      background,
      url
    } = callback;

    let s = url;
    s = s.replace('{{bn}}', bn);
    s = s.replace('{{tx}}', tx);
    s = s.replace('{{sig}}', sig[0]);
    s = s.replace('{{sig[0]}}', sig[0]);

    httpClient
      .post(s, {
        bn,
        tx,
        sig: sig[0],
      })
      .then(() => dispatch({
        type: types.SYSTEM_EOSIOURICALLBACK_SUCCESS,
        payload: {
          s
        }
      }))
      .catch((error) => dispatch({
        type: types.SYSTEM_EOSIOURICALLBACK_FAILURE,
        payload: {
          s,
          error,
        }
      }));
  };
}

export function clearURI() {
  return (dispatch: () => void) => dispatch({
    type: types.SYSTEM_EOSIOURI_RESET
  });
}

export function setURI(uri) {
  return (dispatch: () => void) => {
    dispatch({
      type: types.SYSTEM_EOSIOURI_PENDING
    });
    try {
      // Setup decompression
      const opts = {
        zlib: {
          deflateRaw: (data) => new Uint8Array(zlib.deflateRawSync(Buffer.from(data))),
          inflateRaw: (data) => new Uint8Array(zlib.inflateRawSync(Buffer.from(data))),
        }
      };
      // Interpret the Signing Request
      const request = SigningRequest.from(uri, opts);
      // Extract relevant information
      const {
        data,
        version,
      } = request;
      const {
        broadcast,
        callback,
        req,
      } = data;
      // Pull chainId requested
      const chainId = request.getChainId().toLowerCase();
      return dispatch({
        type: types.SYSTEM_EOSIOURI_SUCCESS,
        payload: {
          broadcast,
          chainId,
          callback,
          req,
          uri,
          version,
        }
      });
    } catch (err) {
      return dispatch({
        type: types.SYSTEM_EOSIOURI_FAILURE,
        payload: {
          err,
          uri
        }
      });
    }
  };
}

export function signURI(tx, blockchain, wallet) {
  return (dispatch: () => void, getState) => {
    const {
      auths,
      connection
    } = getState();
    dispatch({
      type: types.SYSTEM_EOSIOURISIGN_PENDING
    });
    const networkConfig = Object.assign({}, connection, {
      chainId: blockchain.chainId,
      httpEndpoint: blockchain.node,
      signMethod: (wallet.mode === 'ledger') ? 'ledger' : false,
    });
    // Logic to pull unlocked auths from storage
    if (!networkConfig.signMethod && wallet.mode === 'hot') {
      const auth = find(auths, { pubkey: wallet.pubkey });
      if (auth) {
        networkConfig.keyProviderObfuscated = {
          key: auth.key,
          hash: auth.hash,
        };
      }
    }
    // Establish Signer
    const signer = eos(networkConfig, true);
    // Sign the transaction
    signer
      .transaction(tx, {
        broadcast: false, //connection.broadcast,
        expireInSeconds: connection.expireInSeconds,
        sign: true, //connection.sign
      })
      .then((signed) => {
        return dispatch({
          payload: { signed },
          type: types.SYSTEM_EOSIOURISIGN_SUCCESS
        });
        // return dispatch(setTransaction(JSON.stringify({
        //   contract,
        //   transaction: signed
        // })));
      })
      .catch((err) => dispatch({
        payload: { err, tx },
        type: types.SYSTEM_EOSIOURISIGN_FAILURE
      }));
  };
}

export function templateURI(blockchain, wallet) {
  return async (dispatch: () => void, getState) => {
    dispatch({
      type: types.SYSTEM_EOSIOURIBUILD_PENDING,
    });
    const { prompt } = getState();
    const { uri } = prompt;
    const authorization = {
      actor: wallet.account,
      permission: wallet.authorization
    };
    const EOS = eos({
      broadcast: false,
      chainId: blockchain.chainId,
      httpEndpoint: blockchain.node,
      sign: false,
    });
    const head = (await EOS.getInfo(true)).head_block_num;
    const block = await EOS.getBlock(head);
    // Force 2hr expiration of txs, shouldn't hit
    block.expire_seconds = 60 * 60 * 2;
    try {
      // Setup decompression
      const opts = {
        zlib: {
          deflateRaw: (data) => new Uint8Array(zlib.deflateRawSync(Buffer.from(data))),
          inflateRaw: (data) => new Uint8Array(zlib.inflateRawSync(Buffer.from(data))),
        },
        abiProvider: {
          getAbi: async (account) => (await EOS.getAbi(account)).abi
        }
      };
      // Interpret the Signing Request
      const request = SigningRequest.from(uri, opts);
      // Determine the contract name
      let contractName;
      switch (request.data.req[0]) {
        case 'action':
        default:
          contractName = request.data.req[1].account;
          break;
        case 'action[]':
          contractName = request.data.req[1][0].account;
          break;
        case 'transaction':
          contractName = request.data.req[1].actions[0].account;
          break;
      }
      // Form the transaction
      const data = await request.getTransaction(authorization, block);
      // Retrieve the ABI
      const contract = await EOS.getAbi(contractName);
      return dispatch({
        type: types.SYSTEM_EOSIOURIBUILD_SUCCESS,
        payload: {
          contract,
          tx: data
        }
      });
    } catch (err) {
      return dispatch({
        type: types.SYSTEM_EOSIOURIBUILD_FAILURE,
        payload: { err },
      });
    }
  };
}

export default {
  broadcastURI,
  callbackURIWithProcessed,
  clearURI,
  setURI,
  signURI,
  templateURI
};