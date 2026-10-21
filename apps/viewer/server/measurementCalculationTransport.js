'use strict';
// A large result may exceed IPC's immediate write capacity. Keep the channel
// alive until Node confirms that the complete serialized message was written.
function sendCalculationMessage(message, channel = process) {
  return new Promise((resolve, reject) => {
    if (!channel.connected || typeof channel.send !== 'function') return reject(Object.assign(new Error('IPC disconnected'), { code: 'measurement_worker_interrupted' }));
    try { channel.send(message, error => error ? reject(error) : resolve()); }
    catch (error) { reject(error); }
  });
}
module.exports = { sendCalculationMessage };
