'use strict';
const { sendCalculationMessage } = require('../../server/measurementCalculationTransport');
process.once('message', async () => {
  process.channel.ref();
  try {
    await new Promise(resolve=>setTimeout(resolve,25).unref());
    const samples = Array.from({length: 120000}, (_, i) => [i + .123456789, i * .345678901, i * .987654321, 0]);
    await sendCalculationMessage({type: 'result', result: {preview: {samples}, sentinel: 'complete-last-field'}});
  } finally { if (process.connected) process.disconnect(); }
});
