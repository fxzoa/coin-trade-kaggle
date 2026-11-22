/**
 * btc-grid-deno: Hyperliquid EIP-712 暗号署名モジュール
 */

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { keccak256, hexToBytes } from 'viem';
import { encode } from '@msgpack/msgpack';
import { SignerError, toError } from '../errors.ts';

export interface HyperliquidSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
}

export class HyperliquidSigner {
  private account: PrivateKeyAccount;

  constructor(privateKey: string) {
    try {
      const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
      this.account = privateKeyToAccount(formattedKey);
    } catch (err: unknown) {
      const error = toError(err);
      throw new SignerError(`秘密鍵のアカウント初期化に失敗しました: ${error.message}`, {
        cause: err,
      });
    }
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  async signAction(
    action: unknown,
    nonce: number,
    isMainnet: boolean = true,
    vaultAddress?: `0x${string}`
  ): Promise<HyperliquidSignature> {
    const domain = {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000' as const,
    };

    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    };

    const actionBytes = encode(action);
    const nonceBytes = new Uint8Array(8);
    new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
    const vaultMarker = vaultAddress ? new Uint8Array([1]) : new Uint8Array([0]);
    const vaultBytes = vaultAddress ? hexToBytes(vaultAddress.slice(2) as `0x${string}`) : new Uint8Array();

    const dataToHash = new Uint8Array(actionBytes.length + nonceBytes.length + vaultMarker.length + vaultBytes.length);
    dataToHash.set(actionBytes, 0);
    dataToHash.set(nonceBytes, actionBytes.length);
    dataToHash.set(vaultMarker, actionBytes.length + nonceBytes.length);
    if (vaultBytes.length > 0) {
      dataToHash.set(vaultBytes, actionBytes.length + nonceBytes.length + vaultMarker.length);
    }

    const actionHash = keccak256(dataToHash);

    const message = {
      source: isMainnet ? 'a' : 'b',
      connectionId: actionHash,
    };

    try {
      const signatureHex = await this.account.signTypedData({
        domain,
        types,
        primaryType: 'Agent',
        message,
      });

      return this.splitSignature(signatureHex);
    } catch (err: unknown) {
      const error = toError(err);
      throw new SignerError(`署名生成に失敗しました: ${error.message}`, {
        cause: err,
      });
    }
  }

  private splitSignature(sigHex: `0x${string}`): HyperliquidSignature {
    const raw = sigHex.slice(2);
    const r = `0x${raw.slice(0, 64)}` as `0x${string}`;
    const s = `0x${raw.slice(64, 128)}` as `0x${string}`;
    let v = parseInt(raw.slice(128, 130), 16);
    if (v < 27) v += 27;

    return { r, s, v };
  }
}
