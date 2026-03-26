/**
 * Tournament Scheduler
 * Runs daily scoring at midnight UTC and checks for tournament finalization
 */

import cron from 'node-cron';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DAILY_SCORER_PATH = join(__dirname, 'daily-scorer.js');
const FINALIZER_PATH = join(__dirname, 'finalize-tournament.js');

console.log('🕐 Tournament Scheduler Started');
console.log('━'.repeat(60));
console.log(`⏰ Daily scoring: Every day at 00:00 UTC`);
console.log(`🏁 Finalization check: Every hour`);
console.log('━'.repeat(60));

/**
 * Run a script and log output
 */
function runScript(scriptPath, name) {
    return new Promise((resolve, reject) => {
        console.log(`\n▶️  Running ${name}...`);
        console.log(`   Time: ${new Date().toISOString()}`);

        const process = spawn('node', [scriptPath], {
            stdio: 'inherit',
            cwd: dirname(scriptPath)
        });

        process.on('exit', (code) => {
            if (code === 0) {
                console.log(`✅ ${name} completed successfully`);
                resolve();
            } else {
                console.error(`❌ ${name} failed with code ${code}`);
                reject(new Error(`${name} failed`));
            }
        });

        process.on('error', (error) => {
            console.error(`❌ ${name} error:`, error);
            reject(error);
        });
    });
}

// Schedule daily scoring at midnight UTC (00:00)
cron.schedule('0 0 * * *', async () => {
    console.log('\n' + '━'.repeat(60));
    console.log(`📅 Daily Scoring Triggered`);
    console.log(`   UTC Time: ${new Date().toISOString()}`);
    console.log('━'.repeat(60));

    try {
        await runScript(DAILY_SCORER_PATH, 'Daily Scorer');
    } catch (error) {
        console.error('Failed to run daily scorer:', error.message);
    }
}, {
    timezone: 'UTC'
});

// Check for tournament finalization every hour
cron.schedule('0 * * * *', async () => {
    console.log('\n🏁 Checking for tournament finalization...');

    try {
        await runScript(FINALIZER_PATH, 'Tournament Finalizer');
    } catch (error) {
        console.error('Finalization check failed:', error.message);
    }
}, {
    timezone: 'UTC'
});

// Keep process alive
console.log('\n✅ Scheduler is running...');
console.log('   Press Ctrl+C to stop\n');

// Prevent process from exiting
process.stdin.resume();
