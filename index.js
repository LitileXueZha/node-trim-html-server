'use strict';

const path = require('path');
const { TrimHTMLServer, MINIFY_MORE } = require('./TrimHTMLServer.js');

const USAGE = `
Usage: trim-html-server [options] [work_dir]

Options:
    -m, --minify-more  Enable more html-minifier-terser features
    -h, --help         Print help message
`;

function main() {
    const options = readArgs();
    if (options.printUsage) {
        console.log(USAGE);
        return;
    }
    let minifyOpts = { collapseWhitespace: true, collapseInlineTagWhitespace: true };
    if (options.minify) {
        minifyOpts = MINIFY_MORE;
    }
    const serverIns = new TrimHTMLServer(options.dir, minifyOpts);
    serverIns.startup();
}

function readArgs() {
    const options = {
        dir: process.cwd(),
        minify: false,
        printUsage: false,
    };
    for (let i = 2, len = process.argv.length; i < len; i++) {
        const arg = process.argv[i];
        if (arg[0] === '-') {
            switch (arg) {
                case '-h':
                case '--help':
                    options.printUsage = true;
                    break;
                case '-m':
                case '--minify':
                    options.minify = true;
                default:
                    break;
            }
        } else {
            options.dir = path.resolve(arg);
            break;
        }
    }
    return options;
}

exports.main = main;
