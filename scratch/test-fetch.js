const fs = require('fs');

async function test() {
  const res = await fetch('http://localhost:3000/project/euezngeqsjkf/sql');
  console.log('Status:', res.status);
  const text = await res.text();
  const match = text.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (match) {
    const data = JSON.parse(match[1]);
    console.log('Parsed NEXT_DATA:', JSON.stringify(data.err || data.pageProps || data, null, 2));
  } else {
    console.log('No next data found. Text snippet:', text.slice(0, 500));
  }
}

test().catch(console.error);
