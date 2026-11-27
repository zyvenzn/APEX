const assert=require('node:assert/strict');
const test=require('node:test');
const Chart=require('../src/market-chart');
test('aggregates observed prices into chronological OHLC bars',()=>{const bars=Chart.buildCandles([{ts:61000,price:12},{ts:1000,price:10},{ts:30000,price:8},{ts:62000,price:15}],{intervalMs:60000});assert.deepEqual(bars,[{time:0,o:10,h:10,l:8,c:8},{time:60000,o:12,h:15,l:12,c:15}])});
test('ignores invalid points and applies limit',()=>{const bars=Chart.buildCandles([{ts:0,price:2},{ts:60000,price:-1},{ts:120000,price:3},{ts:180000,price:4}],{intervalMs:60000,limit:2});assert.equal(bars.length,2);assert.equal(bars[0].o,3);assert.equal(bars[1].c,4)});
test('does not invent bars for empty valid observations',()=>{assert.deepEqual(Chart.buildCandles([{ts:1,price:0}],{intervalMs:1000}),[])});
