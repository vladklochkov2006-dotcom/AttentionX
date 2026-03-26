// CoFHE SDK utilities for AttentionX
// Wraps @cofhe/sdk for encrypting inputs and decrypting sealed outputs

import { ethers } from 'ethers';
import { getActiveNetwork } from './networks';

// Lazy import to avoid SSR issues — @cofhe/sdk is browser-only
let _cofheModule: any = null;
let _cofheClient: any = null;

async function getCofheModule() {
    if (!_cofheModule) {
        _cofheModule = await import('@cofhe/sdk');
    }
    return _cofheModule;
}

/**
 * Get or create a CofheClient instance.
 * The client is used to encrypt values before sending to the contract
 * and to generate permits for decrypting sealed outputs.
 */
export async function getCofheClient(
    publicClient: any,
    walletClient: any
): Promise<any> {
    if (!_cofheClient) {
        const { CofheClient } = await getCofheModule();
        _cofheClient = new CofheClient();
        await _cofheClient.connect(publicClient, walletClient);

        // Auto-generate a self permit for decryption
        await _cofheClient.permits.getOrCreateSelfPermit();
    }
    return _cofheClient;
}

/**
 * Reset the cached client (e.g., on network switch)
 */
export function resetCofheClient() {
    _cofheClient = null;
    _cofheModule = null;
}

/**
 * Encrypt a uint32 value for use as an InEuint32 contract parameter.
 */
export async function encryptUint32(
    publicClient: any,
    walletClient: any,
    value: number
): Promise<any> {
    const client = await getCofheClient(publicClient, walletClient);
    const { Encryptable } = await getCofheModule();
    const encrypted = await client
        .encryptInputs([Encryptable.uint32(BigInt(value))])
        .execute();
    return encrypted[0];
}

/**
 * Encrypt an array of 19 startup point values.
 * Used by admin when calling setEncryptedPoints.
 */
export async function encryptStartupPoints(
    publicClient: any,
    walletClient: any,
    points: number[]
): Promise<any[]> {
    if (points.length !== 19) {
        throw new Error('Must provide exactly 19 startup point values');
    }
    const client = await getCofheClient(publicClient, walletClient);
    const { Encryptable } = await getCofheModule();

    const encryptables = points.map(p => Encryptable.uint32(BigInt(p)));
    return client.encryptInputs(encryptables).execute();
}

/**
 * Decrypt a ciphertext handle using decryptForView (off-chain, with permit).
 * Returns the plaintext bigint value.
 */
export async function decryptForView(
    publicClient: any,
    walletClient: any,
    ctHash: any,
    fheType: string = 'Uint32'
): Promise<bigint> {
    const client = await getCofheClient(publicClient, walletClient);
    const { FheTypes } = await getCofheModule();

    const typeEnum = (FheTypes as any)[fheType];
    const result = await client
        .decryptForView(ctHash, typeEnum)
        .execute();
    return result;
}

/**
 * Check if the active network supports FHE features
 */
export function isFhenixNetwork(): boolean {
    return getActiveNetwork().isFhenix === true;
}
