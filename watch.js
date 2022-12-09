const fs = require('fs');

/**
 * @param {string} filePath
 * @param {function} listener
 * @param {buffer} buff
 */
function enhancedWatchFile(filePath, listener, buff = Buffer.allocUnsafe(0)) {
    const watcher =  fs.watch(filePath, debounce((eventType, filename) => {
        if (eventType === 'rename') {
            listener(eventType);
            buff = null;
            return;
        }
        fs.readFile(filePath, (err, data) => {
            if (err) {
                return;
            }
            if (data.equals(buff)) {
                return;
            }
            buff = data;
            listener(eventType, data);
        });
    }));
    return watcher;
}

function debounce(fn, duration = 50) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), duration);
    };
}

exports.watch = enhancedWatchFile;
