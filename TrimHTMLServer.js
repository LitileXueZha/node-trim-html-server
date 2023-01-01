const http = require('http');
const fs = require('fs');
const events = require('events');
const path = require('path');
const stream = require('stream');
const zlib = require('zlib');
const htmlTerser = require('html-minifier-terser');
const { watch } = require('./watch.js');

// https://www.npmjs.com/package/html-minifier-terser#options-quick-reference
// https://github.com/jantimon/html-webpack-plugin/blob/main/index.js#L197
const MINIFY_MORE = {
    collapseWhitespace: true,
    collapseInlineTagWhitespace: true,
    keepClosingSlash: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    useShortDoctype: true,
};
const REG_TRIM_URL = /(\?|#).*$/;
const JS_CLIENT = `
<script>
const sse = new EventSource(location.origin + '/livereload');
sse.addEventListener('message', () => location.reload());
sse.onerror = () => sse.close();
window.addEventListener('unload', () => sse.close());
</script>
`;
const MIME_TYPES = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'text/javascript',
    'map': 'application/json', // source map files, eg: *.js.map, *.css.map
};

class TrimHTMLServer extends events {
    constructor(context, opts) {
        super();
        this.context = context;
        this.opts = opts;
        this.watchers = {};
        this.watcherRefs = {}; // a watcher may contains multi Referer
        this.paths = {};
        this.unwatchPaths = new Set();
        this.serve = this.serve.bind(this);
        this.unwatchGC = this.unwatchGC.bind(this);
    }

    startup() {
        const server = http.createServer(this.serve);
        server.listen(8013, () => {
            console.log('Listening on http://127.0.0.1:%s', server.address().port);
        });
        // Auto unwatch files every 5 minutes.
        setInterval(this.unwatchGC, 5*60000);
    }

    /**
     * @param {http.IncomingMessage} req 
     * @param {http.ServerResponse} res 
     */
    serve(req, res) {
        const pathname = req.url.replace(REG_TRIM_URL, '');
        if (pathname === '/livereload') {
            this.sse(req, res);
            return;
        }
        const ext = path.extname(pathname).substring(1);
        const filePath = path.join(this.context, pathname);
        const mimeType = MIME_TYPES[ext] || 'text/plain';
        // console.log(req.headers.referer, pathname, ext);
        console.log('%o %s %o', new Date(), req.method, pathname);
        res.statusCode = 200;
        res.setHeader('content-type', `${mimeType};charset=utf-8`);
        const fStream = fs.createReadStream(filePath);
        fStream.on('error', () => {
            res.statusCode = 404;
            res.end();
        });
        let gzip = new stream.PassThrough();
        const acceptGzip = req.headers['accept-encoding']?.indexOf('gzip') > -1;
        if (ext && acceptGzip) {
            res.setHeader('content-encoding', 'gzip');
            gzip = zlib.createGzip();
        }
        let { referer, host } = req.headers;
        if (ext === 'html') {
            // The first request headers may not include "Referer"
            //
            // "Referer" is controlled by referrer policy.
            // See https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy
            if (!referer) {
                referer = `http://${host}${pathname}`;
            }
    
            const buff = [];
            const client = this.injectSSEScripts();
            fStream.pipe(client);
            client.on('data', (chunk) => buff.push(chunk));
            client.on('end', async () => {
                const html = Buffer.concat(buff).toString();
                const minHtml = await htmlTerser.minify(html, this.opts);
                res.setHeader('cache-control', 'no-cache');
                if (!acceptGzip) {
                    res.removeHeader('content-encoding');
                    res.end(minHtml);
                    return;
                }
                zlib.gzip(minHtml, (err, dataGziped) => {
                    res.end(dataGziped);
                });
            });
        } else {
            fStream.pipe(gzip).pipe(res);
        }
        fStream.on('end', () => {
            // File not exists
            if (res.statusCode === 404) return;
            if (referer) {
                referer = referer.replace(REG_TRIM_URL, '');
                // Exclude non-standard requests and soruce map files.
                if (ext !== 'map') {
                    if (!this.paths[referer]) {
                        this.paths[referer] = new Set();
                    }
                    this.paths[referer].add(filePath);
                }
                // Resources not loaded from original *.html, but another resource file.
                // Eg: css @import
                if (!referer.endsWith('.html')) {
                    const { pathname: refPath } = new URL(referer);
                    const refererPath = path.join(this.context, refPath);
                    let refref;
                    for (const r in this.paths) {
                        if (this.paths[r]?.has(refererPath)) {
                            refref = r;
                            break;
                        }
                    }
                    if (refref) {
                        this.paths[refref].add(filePath);
                    }
                }
            }
        });
    }

    /**
     * @param {http.IncomingMessage} req 
     * @param {http.ServerResponse} res 
     */
    sse(req, res) {
        let { referer } = req.headers;
        if (!referer) {
            res.end();
            return;
        }
        referer = referer.replace(REG_TRIM_URL, '');
        res.setHeader('content-type', 'text/event-stream');
        res.write('event: sse\ndata: connected\n\n');
        const files = this.paths[referer];
        if (!files || files.size === 0) {
            // Browser may use BF cache, files are not collected.
            //
            // This is not expected behavior in development, enfoce refreshing.
            res.write('event: message\ndata: 1\n\n');
            return;
        }
        // console.log('Paths: %o, watched:', this.paths, Object.keys(this.watchers));
        for (const filePath of files) {
            if (filePath in this.watchers) {
                this.unwatchPaths.delete(filePath);
                this.watcherRefs[filePath].add(referer);
            } else {
                const watcher = watch(filePath, (eventType, data) => {
                    this.emit('filechange', filePath);
                });
                this.watchers[filePath] = watcher;
                this.watcherRefs[filePath] = new Set([referer]);
            }
        }
        const sendReloadMessage = (filePath) => {
            if (this.watcherRefs[filePath]?.has(referer)) {
                res.write('event: message\ndata: 1\n\n');
            }
        }
        // In multi-window, the resource file in same url may be watched,
        // so we need to listen on the server instance.
        this.once('filechange', sendReloadMessage);
        req.on('close', () => {
            // When connection closed, those files' watcher will be auto closed.
            files.forEach((f) => {
                this.unwatchPaths.add(f);
                this.watcherRefs[f].delete(referer);
            });
            this.off('filechange', sendReloadMessage);
        });
        // console.log(files, Object.keys(this.watchers).length, referer);
        // Prepare for next connection
        files.clear();
    }

    unwatchGC() {
        for (const filePath of this.unwatchPaths) {
            const watcher = this.watchers[filePath];
            const referers = this.watcherRefs[filePath];
            if (watcher && (!referers || referers.size === 0)) {
                watcher.close();
                delete this.watchers[filePath];
                console.log('unwatch %o', filePath);
            }
        }
        this.unwatchPaths.clear();
    }

    injectSSEScripts() {
        return new stream.Transform({
            transform(chunk, encoding, done) {
                if (!this._injected) {
                    const rawHtml = chunk.toString();
                    const index = rawHtml.indexOf('</body>');
                    if (index > -1) {
                        const res = rawHtml.replace('</body>', `${JS_CLIENT}</body>`);
                        done(null, res);
                        this._injected = true;
                        return;
                    }
                }
                done(null, chunk);
            },
        });
    }
}

exports.TrimHTMLServer = TrimHTMLServer;
exports.MINIFY_MORE = MINIFY_MORE;
