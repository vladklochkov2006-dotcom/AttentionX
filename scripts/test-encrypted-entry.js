/**
 * Test FHE encrypted tournament entry — Node.js + CoFHE SDK
 * Usage: npx tsx scripts/test-encrypted-entry.js
 */

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/node';
import { sepolia as cofheSepolia } from '@cofhe/sdk/chains';
import { Encryptable } from '@cofhe/sdk';
import { ethers } from 'ethers';

const PRIVATE_KEY = '0xead62b1e3a049ef32808015aa4cec6beb236ece3a2629342490939e645643561';
const PROXY = '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81';
const NFT = '0x409384AF735AAe5AD58cE4dc70c9309E9f3E72aF';
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const TOURNAMENT_ID = 12;

// Correct ABI matching InEuint32 struct: (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)
const ABI = [
    'function enterTournament(uint256 tournamentId, tuple(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)[5] encryptedCardIds)',
    'function hasEntered(uint256, address) view returns (bool)',
    'function getEncryptedLineup(uint256, address) view returns (uint256[5])',
    'function getUserLineup(uint256, address) view returns (tuple(uint256[5] cardIds, address owner, uint256 timestamp, bool cancelled, bool claimed))',
    'function playerVerified(uint256, address) view returns (bool)',
    'function getTournamentParticipants(uint256) view returns (address[])',
];

const NFT_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
    'function getCardInfo(uint256) view returns (tuple(uint256 startupId, uint256 edition, uint8 rarity, uint256 multiplier, bool isLocked, string name))',
];

async function main() {
    console.log('=== FHE Encrypted Entry Test ===\n');

    const account = privateKeyToAccount(PRIVATE_KEY);
    console.log('Account:', account.address);

    const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
    const walletClient = createWalletClient({ chain: sepolia, transport: http(RPC), account });

    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(PRIVATE_KEY.slice(2), provider);
    const tournament = new ethers.Contract(PROXY, ABI, wallet);
    const nft = new ethers.Contract(NFT, NFT_ABI, provider);

    const entered = await tournament.hasEntered(TOURNAMENT_ID, account.address);
    if (entered) {
        console.log('Already entered. Checking privacy...\n');
    } else {
        // Find cards
        const balance = Number(await nft.balanceOf(account.address));
        console.log('NFTs owned:', balance);
        if (balance < 5) { console.log('Need 5+ NFTs!'); return; }

        const cardIds = [];
        for (let i = 0; i < 5; i++) {
            const tokenId = Number(await nft.tokenOfOwnerByIndex(account.address, i));
            const info = await nft.getCardInfo(tokenId);
            cardIds.push(tokenId);
            console.log(`  Card #${tokenId}: ${info.name} (startup ${Number(info.startupId)})`);
        }

        // Encrypt with CoFHE SDK
        console.log('\nInitializing CoFHE...');
        const config = createCofheConfig({ supportedChains: [cofheSepolia] });
        const cofheClient = createCofheClient(config);
        await cofheClient.connect(publicClient, walletClient);

        console.log('Encrypting cards...');
        const encryptables = cardIds.map(id => Encryptable.uint32(BigInt(id)));
        const encrypted = await cofheClient.encryptInputs(encryptables)
            .setAccount(account.address)
            .onStep((step) => console.log('  [CoFHE]', step))
            .execute();

        console.log('\nEncrypted:');
        for (let i = 0; i < 5; i++) {
            const e = encrypted[i];
            console.log(`  [${i}] ctHash=${e.ctHash.toString().substring(0, 16)}... zone=${e.securityZone} type=${e.utype} sig=${e.signature.substring(0, 16)}...`);
        }

        // Submit to contract — pass encrypted objects directly
        console.log('\nSubmitting to contract...');
        try {
            const tx = await tournament.enterTournament(TOURNAMENT_ID, encrypted);
            console.log('TX:', tx.hash);
            const receipt = await tx.wait();
            console.log('✓ Confirmed! Block:', receipt.blockNumber, 'Gas:', receipt.gasUsed.toString());

            // Verify tx calldata doesn't contain plaintext
            console.log('\n--- TX Calldata Analysis ---');
            for (const id of cardIds) {
                const hexId = id.toString(16).padStart(4, '0');
                const found = tx.data.toLowerCase().includes(hexId);
                console.log(`  Card #${id} (0x${hexId}) in calldata: ${found ? '⚠ FOUND' : '✓ NOT FOUND (encrypted)'}`);
            }
        } catch (err) {
            console.error('TX failed:', err.reason || err.message?.substring(0, 150));
            return;
        }
    }

    // Privacy check
    console.log('\n=== Privacy Verification ===\n');

    console.log('Encrypted lineup:');
    const encLineup = await tournament.getEncryptedLineup(TOURNAMENT_ID, account.address);
    for (let i = 0; i < 5; i++) {
        const h = encLineup[i].toString();
        console.log(`  [${i}] ${h.length > 20 ? h.substring(0, 20) + '...' : h} ${h !== '0' ? '✓ encrypted' : '- empty'}`);
    }

    console.log('\nPlaintext lineup:');
    const lineup = await tournament.getUserLineup(TOURNAMENT_ID, account.address);
    let allHidden = true;
    for (let i = 0; i < 5; i++) {
        const v = Number(lineup.cardIds[i]);
        if (v !== 0) allHidden = false;
        console.log(`  [${i}] ${v} ${v === 0 ? '✓ HIDDEN' : '⚠ VISIBLE'}`);
    }

    const verified = await tournament.playerVerified(TOURNAMENT_ID, account.address);
    console.log('\nVerified:', verified);

    console.log('\n=== Verdict ===');
    if (allHidden && !verified) {
        console.log('✓ FULL PRIVACY — cards encrypted on-chain, plaintext empty');
    } else if (verified) {
        console.log('Cards visible after admin verification (for scoring)');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
