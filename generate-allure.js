import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const reportsDir = path.join(process.cwd(), 'reports');
const newmanFiles = fs.readdirSync(reportsDir).filter(f => f.startsWith('newman-') && f.endsWith('.json'));

if (!newmanFiles.length) {
  console.log('❌ No Newman JSON reports found.');
  process.exit(1);
}

// Use the latest JSON file
const latestRun = path.join(reportsDir, newmanFiles.sort().pop());

// Convert JSON to Allure
try {
  execSync(`allure generate ${latestRun} -o ${path.join(reportsDir, 'allure-report')} --clean`, { stdio: 'inherit' });
  console.log('✅ Allure report generated at ./reports/allure-report');
} catch (err) {
  console.error('❌ Error generating Allure report:', err.message);
  process.exit(1);
}

// Generate simple trend dashboard (last 10 runs)
const trendFile = path.join(reportsDir, 'trend.json');
let trendData = [];
if (fs.existsSync(trendFile)) trendData = JSON.parse(fs.readFileSync(trendFile));

const stats = JSON.parse(fs.readFileSync(latestRun)).run.stats;
trendData.push({
  date: new Date().toLocaleString(),
  total: stats.requests.total,
  failed: stats.requests.failed,
  duration: stats.iterations.total > 0 ? stats.iterations.total : 0
});

// Keep last 10 runs
if (trendData.length > 10) trendData.shift();
fs.writeFileSync(trendFile, JSON.stringify(trendData, null, 2));
console.log('✅ Trend data updated for last 10 runs');
