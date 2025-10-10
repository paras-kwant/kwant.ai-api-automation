require('dotenv').config();
const newman = require('newman');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Config
const COLLECTION_UID = process.env.COLLECTION_UID;
const API_KEY = process.env.POSTMAN_API_KEY;
const SURGE_TOKEN = process.env.SURGE_TOKEN;
const SURGE_URL = 'kwant-automation-dashboard.surge.sh';

const ALLURE_RESULTS_DIR = path.join(__dirname, 'allure-results');
const ALLURE_REPORT_DIR = path.join(__dirname, 'allure-report');
const HISTORY_DIR = path.join(__dirname, '.history'); // store last 3 runs

// Ensure directories exist
[ALLURE_RESULTS_DIR, HISTORY_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Clean allure-results except history folder
function cleanAllureResults() {
    if (fs.existsSync(ALLURE_RESULTS_DIR)) {
        fs.readdirSync(ALLURE_RESULTS_DIR).forEach(file => {
            if (file !== 'history') {
                fs.rmSync(path.join(ALLURE_RESULTS_DIR, file), { recursive: true, force: true });
            }
        });
        console.log('🧹 Cleared previous allure-results (trend preserved)');
    }
}

// Extract base URL and environment from collection
function extractEnvironmentInfo(collection) {
    let baseUrl = 'https://api.example.com';
    let environment = 'unknown';

    try {
        // Recursively find all requests in collection
        const findRequests = (items) => {
            const requests = [];
            if (!items) return requests;

            items.forEach(item => {
                if (item.request && item.request.url) {
                    requests.push(item.request.url);
                }
                if (item.item) {
                    requests.push(...findRequests(item.item));
                }
            });
            return requests;
        };

        const urls = findRequests(collection.item);
        console.log(`📊 Found ${urls.length} requests in collection`);
        
        if (urls.length > 0) {
            // Get the first URL and handle different formats
            let firstUrl = urls[0];
            console.log(`🔍 Raw URL object:`, JSON.stringify(firstUrl, null, 2));
            
            let urlString = '';
            
            // Handle different Postman URL formats
            if (typeof firstUrl === 'string') {
                urlString = firstUrl;
            } else if (typeof firstUrl === 'object') {
                // Try different properties Postman might use
                urlString = firstUrl.raw || 
                           firstUrl.href || 
                           (firstUrl.protocol ? `${firstUrl.protocol}://${firstUrl.host?.join?.('.') || firstUrl.host}` : '');
            }

            console.log(`🔗 Extracted URL string: ${urlString}`);

            if (urlString) {
                // Remove variables like {{baseUrl}}
                urlString = urlString.replace(/\{\{[^}]+\}\}/g, '');
                
                // Parse URL to extract base URL
                const urlMatch = urlString.match(/^(https?:\/\/[^\/\?]+)/);
                if (urlMatch) {
                    baseUrl = urlMatch[1];
                 
                    const hostMatch = baseUrl.match(/https?:\/\/([^.]+)\./);
                    if (hostMatch) {
                        const subdomain = hostMatch[1];
                        if (['uat', 'staging', 'stage', 'dev', 'test', 'qa'].includes(subdomain.toLowerCase())) {
                            environment = subdomain.toLowerCase();
                        } else if (['www', 'api'].includes(subdomain.toLowerCase())) {
                            environment = 'production';
                        } else {
                            environment = subdomain.toLowerCase();
                        }
                    } else {
                        environment = 'production';
                    }
                }
            }
        }

        console.log(`🌍 Detected Base URL: ${baseUrl}`);
        console.log(`🔧 Detected Environment: ${environment}`);
    } catch (err) {
        console.warn('⚠️ Could not extract environment info, using defaults:', err.message);
        console.error(err);
    }

    return { baseUrl, environment };
}

// Add executor info
function addExecutorInfo() {
    const content = `
executor.name=ParasOli
executor.type=CLI
executor.build=1
executor.url=http://localhost
`.trim();
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'executor.properties'), content);
}

// Add environment info dynamically
function addEnvironmentInfo(baseUrl, environment) {
    const content = `
POSTMAN_ENV=${environment}
API_URL=${baseUrl}
TIMESTAMP=${new Date().toISOString()}
`.trim();
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'environment.properties'), content);
    console.log(`📝 Environment info saved: ${environment} - ${baseUrl}`);
}

// Fetch Postman collection
async function getCollection() {
    const url = `https://api.getpostman.com/collections/${COLLECTION_UID}`;
    const res = await axios.get(url, { headers: { 'X-Api-Key': API_KEY } });
    return res.data.collection;
}

// Merge last 3 runs into allure-results/history
function mergeHistory() {
    const targetHistory = path.join(ALLURE_RESULTS_DIR, 'history');

    if (fs.existsSync(targetHistory)) fs.rmSync(targetHistory, { recursive: true, force: true });
    fs.mkdirSync(targetHistory, { recursive: true });

    const folders = fs.readdirSync(HISTORY_DIR)
        .map(name => ({ name, time: fs.statSync(path.join(HISTORY_DIR, name)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time) // newest first
        .slice(0, 3) // last 3 runs
        .reverse(); // oldest first

    folders.forEach(folder => {
        const src = path.join(HISTORY_DIR, folder.name);
        if (fs.existsSync(src)) {
            fs.readdirSync(src).forEach(file => {
                const srcFile = path.join(src, file);
                const destFile = path.join(targetHistory, `${folder.name}-${file}`); // unique name
                fs.copyFileSync(srcFile, destFile);
            });
        }
    });

    console.log('📂 Merged last 3 runs into allure-results/history');
}

// Generate Allure HTML report
function generateAllureReport() {
    mergeHistory();
    return new Promise((resolve, reject) => {
        const cmd = `allure generate ${ALLURE_RESULTS_DIR} -o ${ALLURE_REPORT_DIR} --clean`;
        exec(cmd, err => {
            if (err) return reject(err);
            console.log('✅ Allure HTML report generated!');
            resolve();
        });
    });
}

// Save current run to .history and prune older than 3
function saveCurrentRunHistory() {
    const reportHistory = path.join(ALLURE_REPORT_DIR, 'history');
    if (!fs.existsSync(reportHistory)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runFolder = path.join(HISTORY_DIR, timestamp);
    fs.mkdirSync(runFolder, { recursive: true });

    fs.readdirSync(reportHistory).forEach(file => {
        const srcFile = path.join(reportHistory, file);
        fs.copyFileSync(srcFile, path.join(runFolder, file));
    });

    console.log(`📂 Saved current run's history to ${runFolder}`);

    // Keep only last 3 runs
    const folders = fs.readdirSync(HISTORY_DIR)
        .map(name => ({ name, time: fs.statSync(path.join(HISTORY_DIR, name)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);

    for (let i = 3; i < folders.length; i++) {
        fs.rmSync(path.join(HISTORY_DIR, folders[i].name), { recursive: true, force: true });
        console.log(`🗑️ Deleted old history: ${folders[i].name}`);
    }
}

// Deploy to Surge using token
function deployToSurge() {
    return new Promise((resolve, reject) => {
        const cmd = `surge ./allure-report ${SURGE_URL} --token ${SURGE_TOKEN}`;
        exec(cmd, (err, stdout, stderr) => {
            console.log('Surge Output:', stdout);
            if (stderr) console.log('Surge Stderr:', stderr);
            if (err) {
                console.error('Surge Error:', err);
                return reject(err);
            }
            console.log(`🌐 Allure report deployed to Surge: https://${SURGE_URL}`);
            resolve();
        });
    });
}

// Run Newman tests
async function runTests() {
    if (!COLLECTION_UID || !API_KEY || !SURGE_TOKEN) {
        console.error('❌ Missing COLLECTION_UID, POSTMAN_API_KEY or SURGE_TOKEN in .env');
        process.exit(1);
    }

    cleanAllureResults();
    addExecutorInfo();

    const collection = await getCollection();
    
    // Debug: Log collection structure
    console.log('📦 Collection Name:', collection.info?.name || 'Unknown');
    console.log('📦 Collection has items:', !!collection.item);
    
    // Extract environment info from collection URLs
    const { baseUrl, environment } = extractEnvironmentInfo(collection);
    addEnvironmentInfo(baseUrl, environment);

    newman.run({
        collection,
        reporters: ['cli', 'allure'],
        reporter: { allure: { export: ALLURE_RESULTS_DIR } },
        iterationCount: 1
    }, async (err, summary) => {
        if (err) return console.error('❌ Newman run failed:', err);

        console.log('✅ Newman tests completed!');
        console.log(`Total requests: ${summary.run.stats.requests.total}`);
        console.log(`Failed requests: ${summary.run.stats.requests.failed}`);
        console.log(`Failed assertions: ${summary.run.stats.assertions.failed}`);

        try {
            await generateAllureReport();  // merge trend
            saveCurrentRunHistory();       // save current run
            await deployToSurge();         // deploy online via token
        } catch (err) {
            console.error('❌ Could not generate/deploy Allure report:', err.message);
        }

        process.exit(summary.run.stats.assertions.failed > 0 ? 1 : 0);
    });
}

runTests();