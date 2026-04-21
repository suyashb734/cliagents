const http = require('http');

/**
 * Gemini Speed Comparison Test
 * Compares gemini-cli (CLI adapter) vs gemini-api (Direct HTTP adapter)
 */

const PROMPT = "What is 2+2? Reply with just the number.";
const API_URL = 'http://localhost:4001/ask';
const API_KEY = process.env.CLI_AGENTS_API_KEY || '';

/**
 * Helper to make a request to the /ask endpoint
 */
async function testAdapter(adapterName) {
  const start = Date.now();
  const postData = JSON.stringify({
    message: PROMPT,
    adapter: adapterName
  });

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  };

  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  return new Promise((resolve) => {
    const req = http.request(
      API_URL,
      {
        method: 'POST',
        headers: headers
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const end = Date.now();
          const duration = end - start;
          let content = '';
          
          try {
            const json = JSON.parse(data);
            // Handle error response from server
            if (json.error) {
              content = `Error: ${json.error.message || json.error}`;
            } else {
              // Extract content from various possible response formats
              content = json.response || json.content || (json.choices && json.choices[0]?.message?.content) || JSON.stringify(json);
            }
          } catch (e) {
            content = data;
          }

          resolve({
            'Adapter name': adapterName,
            'Response time (ms)': duration,
            'Response content (50 chars)': content.substring(0, 50).trim().replace(/\n/g, ' '),
            'Status': res.statusCode
          });
        });
      }
    );

    req.on('error', (e) => {
      resolve({
        'Adapter name': adapterName,
        'Response time (ms)': -1,
        'Response content (50 chars)': `Connection Error: ${e.message}`,
        'Status': 0
      });
    });

    // Set a timeout for the request (60s as LLMs can be slow)
    req.setTimeout(60000, () => {
      req.destroy();
      resolve({
        'Adapter name': adapterName,
        'Response time (ms)': -1,
        'Response content (50 chars)': 'Request Timed Out (60s)',
        'Status': 0
      });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Main execution function
 */
async function runTests() {
  console.log('\nGemini Speed Comparison Test');
  console.log('============================');
  console.log(`Prompt: "${PROMPT}"`);
  console.log(`Server: ${API_URL}`);
  console.log('\nTesting adapters...\n');
  
  const results = [];
  
  // Test gemini-cli
  process.stdout.write('- Testing gemini-cli... ');
  const cliResult = await testAdapter('gemini-cli');
  console.log(cliResult['Status'] === 200 ? 'Done' : 'Failed');
  results.push(cliResult);
  
  // Test gemini-api
  process.stdout.write('- Testing gemini-api... ');
  const apiResult = await testAdapter('gemini-api');
  console.log(apiResult['Status'] === 200 ? 'Done' : 'Failed');
  results.push(apiResult);

  // Print Comparison Table
  console.log('\nComparison Results:');
  const tableData = results.map(r => ({
    'Adapter': r['Adapter name'],
    'Time (ms)': r['Response time (ms)'] === -1 ? 'N/A' : r['Response time (ms)'],
    'Content': r['Response content (50 chars)'],
    'Status': r['Status']
  }));
  console.table(tableData);

  // Conclusion and handling for gemini-api failures
  const successful = results.filter(r => r.Status === 200);
  
  if (successful.length === 2) {
    const cliTime = results.find(r => r['Adapter name'] === 'gemini-cli')['Response time (ms)'];
    const apiTime = results.find(r => r['Adapter name'] === 'gemini-api')['Response time (ms)'];
    
    const diff = Math.abs(cliTime - apiTime);
    const winner = cliTime < apiTime ? 'gemini-cli' : 'gemini-api';
    const percent = Math.round((diff / Math.max(cliTime, apiTime)) * 100);
    
    console.log(`\nConclusion: ${winner} was faster by ${diff}ms (${percent}%).`);
  } else {
    const apiResult = results.find(r => r['Adapter name'] === 'gemini-api');
    if (apiResult && apiResult.Status !== 200) {
      console.log('\nNote: gemini-api failed or was unavailable.');
      console.log('Ensure GOOGLE_API_KEY is set in your environment or configured for the server.');
    }
    
    const cliResult = results.find(r => r['Adapter name'] === 'gemini-cli');
    if (cliResult && cliResult.Status !== 200) {
      console.log('Note: gemini-cli failed. Ensure the Gemini CLI is installed and authenticated (`gemini login`).');
    }
  }
}

// Check if server is reachable first
const healthCheck = http.get(API_URL.replace('/ask', '/health'), (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode === 200) {
      runTests();
    } else {
      console.error(`Error: Server at ${API_URL} returned status ${res.statusCode}`);
      console.error(`Response: ${data}`);
      process.exit(1);
    }
  });
}).on('error', (e) => {
  console.error(`Error: Could not connect to cliagents server at ${API_URL}`);
  console.error(`Ensure the server is running (e.g., run 'npm start' in a separate terminal).`);
  process.exit(1);
});
