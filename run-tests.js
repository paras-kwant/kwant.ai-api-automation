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
const SURGE_URL = process.env.SURGE_URL || 'kwant-automation-dashboard.surge.sh';

const ALLURE_RESULTS_DIR = path.join(__dirname, 'allure-results');
const ALLURE_REPORT_DIR = path.join(__dirname, 'allure-report');
const HISTORY_DIR = path.join(__dirname, '.history');

// ⚠️ CRITICAL: Headers/fields to mask in reports
const SENSITIVE_PATTERNS = [
    'api-key',
    'authorization',
    'x-api-key',
    'postman-token',
    'cookie',
    'set-cookie',
    'x-auth-token',
    'bearer',
    'password',
    'secret',
    'token',
    'auth'
];

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

// 🔒 Sanitize sensitive data from Allure JSON results
function sanitizeAllureResults() {
    try {
        const files = fs.readdirSync(ALLURE_RESULTS_DIR).filter(f => f.endsWith('-result.json'));
        
        files.forEach(file => {
            const filePath = path.join(ALLURE_RESULTS_DIR, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            // Sanitize attachments (request/response bodies)
            if (data.attachments) {
                data.attachments.forEach(attachment => {
                    if (attachment.source && fs.existsSync(path.join(ALLURE_RESULTS_DIR, attachment.source))) {
                        const content = fs.readFileSync(path.join(ALLURE_RESULTS_DIR, attachment.source), 'utf8');
                        const sanitized = maskSensitiveData(content);
                        fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, attachment.source), sanitized);
                    }
                });
            }
            
            // Sanitize parameters
            if (data.parameters) {
                data.parameters = data.parameters.map(param => {
                    if (isSensitiveField(param.name)) {
                        return { ...param, value: '***REDACTED***' };
                    }
                    return param;
                });
            }
            
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        });
        
        console.log(`🔒 Sanitized ${files.length} Allure result files`);
    } catch (err) {
        console.error('⚠️ Error sanitizing Allure results:', err.message);
    }
}

// Check if field name is sensitive
function isSensitiveField(fieldName) {
    if (!fieldName) return false;
    const lowerField = fieldName.toLowerCase();
    return SENSITIVE_PATTERNS.some(pattern => lowerField.includes(pattern));
}

// Mask sensitive data in text content
function maskSensitiveData(content) {
    let masked = content;
    
    // Mask common patterns
    const patterns = [
        // API keys (32-40 char alphanumeric)
        /["']?api[-_]?key["']?\s*[:=]\s*["']?([a-zA-Z0-9]{32,40})["']?/gi,
        // Bearer tokens
        /["']?authorization["']?\s*[:=]\s*["']?Bearer\s+([a-zA-Z0-9\-._~+\/]+=*)["']?/gi,
        // Generic tokens
        /["']?[a-z]*token["']?\s*[:=]\s*["']?([a-zA-Z0-9\-._~+\/]{20,})["']?/gi,
        // Passwords
        /["']?password["']?\s*[:=]\s*["']?([^"'\s,}]{3,})["']?/gi,
    ];
    
    patterns.forEach(pattern => {
        masked = masked.replace(pattern, (match, group1) => {
            return match.replace(group1, '***REDACTED***');
        });
    });
    
    // Mask sensitive headers in JSON
    SENSITIVE_PATTERNS.forEach(pattern => {
        const regex = new RegExp(`"${pattern}"\\s*:\\s*"([^"]*)"`, 'gi');
        masked = masked.replace(regex, `"${pattern}": "***REDACTED***"`);
    });
    
    return masked;
}

// Extract base URL and environment from collection
function extractEnvironmentInfo(collection) {
    let baseUrl = 'https://api.example.com';
    let environment = 'unknown';

    try {
        const findRequests = (items) => {
            const requests = [];
            if (!items) return requests;

            items.forEach(item => {
                if (item.request?.url) {
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
            let firstUrl = urls[0];
            let urlString = '';
            
            if (typeof firstUrl === 'string') {
                urlString = firstUrl;
            } else if (typeof firstUrl === 'object') {
                urlString = firstUrl.raw || 
                           firstUrl.href || 
                           (firstUrl.protocol ? `${firstUrl.protocol}://${firstUrl.host?.join?.('.') || firstUrl.host}` : '');
            }

            if (urlString) {
                urlString = urlString.replace(/\{\{[^}]+\}\}/g, '');
                
                const urlMatch = urlString.match(/^(https?:\/\/[^\/\?]+)/);
                if (urlMatch) {
                    baseUrl = urlMatch[1];
                 
                    const hostMatch = baseUrl.match(/https?:\/\/([^.]+)\./);
                    if (hostMatch) {
                        const subdomain = hostMatch[1].toLowerCase();
                        if (['uat', 'staging', 'stage', 'dev', 'test', 'qa'].includes(subdomain)) {
                            environment = subdomain;
                        } else if (['www', 'api'].includes(subdomain)) {
                            environment = 'production';
                        } else {
                            environment = subdomain;
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
        console.warn('⚠️ Could not extract environment info:', err.message);
    }

    return { baseUrl, environment };
}

// Add executor info
function addExecutorInfo() {
    const content = `executor.name=Newman
executor.type=CLI
executor.build=${process.env.BUILD_NUMBER || '1'}
executor.url=${process.env.CI_URL || 'http://localhost'}`;
    
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'executor.properties'), content);
}

// Add environment info
function addEnvironmentInfo(baseUrl, environment) {
    const content = `POSTMAN_ENV=${environment}
API_URL=${baseUrl}
TIMESTAMP=${new Date().toISOString()}
NODE_VERSION=${process.version}`;
    
    fs.writeFileSync(path.join(ALLURE_RESULTS_DIR, 'environment.properties'), content);
    console.log(`📝 Environment info saved: ${environment} - ${baseUrl}`);
}

// Fetch Postman collection
async function getCollection() {
    if (!COLLECTION_UID || !API_KEY) {
        throw new Error('COLLECTION_UID and POSTMAN_API_KEY are required');
    }
    
    const url = `https://api.getpostman.com/collections/${COLLECTION_UID}`;
    
    try {
        const res = await axios.get(url, { 
            headers: { 'X-Api-Key': API_KEY },
            timeout: 10000
        });
        return res.data.collection;
    } catch (err) {
        console.error('❌ Failed to fetch collection:', err.message);
        throw err;
    }
}

// Merge last 3 runs into allure-results/history
function mergeHistory() {
    const targetHistory = path.join(ALLURE_RESULTS_DIR, 'history');

    if (fs.existsSync(targetHistory)) {
        fs.rmSync(targetHistory, { recursive: true, force: true });
    }
    fs.mkdirSync(targetHistory, { recursive: true });

    if (!fs.existsSync(HISTORY_DIR)) {
        console.log('📂 No history directory found, skipping merge');
        return;
    }

    const folders = fs.readdirSync(HISTORY_DIR)
        .map(name => ({ 
            name, 
            time: fs.statSync(path.join(HISTORY_DIR, name)).mtime.getTime() 
        }))
        .sort((a, b) => b.time - a.time)
        .slice(0, 3)
        .reverse();

    folders.forEach(folder => {
        const src = path.join(HISTORY_DIR, folder.name);
        if (fs.existsSync(src)) {
            fs.readdirSync(src).forEach(file => {
                const srcFile = path.join(src, file);
                const destFile = path.join(targetHistory, `${folder.name}-${file}`);
                fs.copyFileSync(srcFile, destFile);
            });
        }
    });

    console.log(`📂 Merged last ${folders.length} runs into allure-results/history`);
}

// Generate Allure HTML report
function generateAllureReport() {
    mergeHistory();
    return new Promise((resolve, reject) => {
        const cmd = `allure generate ${ALLURE_RESULTS_DIR} -o ${ALLURE_REPORT_DIR} --clean`;
        exec(cmd, (err, stdout, stderr) => {
            if (err) {
                console.error('Allure generation error:', stderr);
                return reject(err);
            }
            console.log('✅ Allure HTML report generated!');
            resolve();
        });
    });
}

// Save current run to .history
function saveCurrentRunHistory() {
    const reportHistory = path.join(ALLURE_REPORT_DIR, 'history');
    if (!fs.existsSync(reportHistory)) {
        console.log('⚠️ No history folder in report, skipping save');
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runFolder = path.join(HISTORY_DIR, timestamp);
    fs.mkdirSync(runFolder, { recursive: true });

    fs.readdirSync(reportHistory).forEach(file => {
        const srcFile = path.join(reportHistory, file);
        fs.copyFileSync(srcFile, path.join(runFolder, file));
    });

    console.log(`💾 Saved current run's history to ${runFolder}`);

    // Keep only last 3 runs
    const folders = fs.readdirSync(HISTORY_DIR)
        .map(name => ({ 
            name, 
            time: fs.statSync(path.join(HISTORY_DIR, name)).mtime.getTime() 
        }))
        .sort((a, b) => b.time - a.time);

    for (let i = 3; i < folders.length; i++) {
        fs.rmSync(path.join(HISTORY_DIR, folders[i].name), { recursive: true, force: true });
        console.log(`🗑️ Deleted old history: ${folders[i].name}`);
    }
}

// Deploy to Surge
function deployToSurge() {
    if (!SURGE_TOKEN) {
        console.log('⚠️ SURGE_TOKEN not set, skipping deployment');
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const cmd = `surge ./allure-report ${SURGE_URL} --token ${SURGE_TOKEN}`;
        exec(cmd, (err, stdout, stderr) => {
            if (stdout) console.log('Surge Output:', stdout);
            if (stderr) console.log('Surge Stderr:', stderr);
            
            if (err) {
                console.error('❌ Surge deployment failed:', err.message);
                return reject(err);
            }
            
            console.log(`🌐 Report deployed: https://${SURGE_URL}`);
            resolve();
        });
    });
}

// Main test runner
async function runTests() {
    try {
        if (!COLLECTION_UID || !API_KEY) {
            throw new Error('Missing required env vars: COLLECTION_UID, POSTMAN_API_KEY');
        }

        console.log('🚀 Starting test execution...\n');

        cleanAllureResults();
        addExecutorInfo();

        const collection = await getCollection();
        console.log('📦 Collection:', collection.info?.name || 'Unknown');
        
        const { baseUrl, environment } = extractEnvironmentInfo(collection);
        addEnvironmentInfo(baseUrl, environment);

        // Run Newman with Promise wrapper for better error handling
        const runNewman = () => new Promise((resolve, reject) => {
            newman.run({
                collection,
                reporters: ['cli', 'allure'],
                reporter: { 
                    allure: { 
                        export: ALLURE_RESULTS_DIR,
                        // Newman-reporter-allure options
                        resultsDir: ALLURE_RESULTS_DIR
                    } 
                },
                iterationCount: 1,
                bail: false, // Continue on failures
                color: 'on'
            }, (err, summary) => {
                if (err) return reject(err);
                
                console.log('\n📊 Test Summary:');
                console.log(`   Total: ${summary.run.stats.requests.total}`);
                console.log(`   Failed: ${summary.run.stats.requests.failed}`);
                console.log(`   Assertions Failed: ${summary.run.stats.assertions.failed}`);
                
                resolve(summary);
            });
        });

        const summary = await runNewman();

        // 🔒 CRITICAL: Sanitize sensitive data before generating report
        console.log('\n🔒 Sanitizing sensitive data...');
        sanitizeAllureResults();

        await generateAllureReport();
        saveCurrentRunHistory();
        await deployToSurge();

        console.log('\n✅ Test execution completed!\n');
        
        // Exit with appropriate code
        process.exit(summary.run.stats.assertions.failed > 0 ? 1 : 0);
        
    } catch (err) {
        console.error('\n❌ Fatal error:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
}

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.error('💥 Unhandled Rejection:', err);
    process.exit(1);
});

runTests();
