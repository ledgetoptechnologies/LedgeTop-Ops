'use strict';
const fs = require('fs');
const path = require('path');
function reconstructionAvailable(config = {}) {
  const binary = config.measurementPoissonBin || process.env.MEASUREMENT_POISSON_BIN || '/opt/poisson/PoissonRecon';
  try { return fs.statSync(binary).isFile() && fs.readFileSync(path.join(path.dirname(binary),'build-info.json'),'utf8').includes('262b0f539d404057d1f36e1adc07fc9388678899'); } catch { return false; }
}
module.exports = { reconstructionAvailable };
