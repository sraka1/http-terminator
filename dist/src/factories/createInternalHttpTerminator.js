"use strict";
/* eslint-disable import/order */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const p_wait_for_1 = __importDefault(require("p-wait-for"));
const Logger_1 = __importDefault(require("../Logger"));
const log = Logger_1.default.child({
    namespace: 'createHttpTerminator',
});
const configurationDefaults = {
    gracefulTerminationTimeout: 1000,
};
exports.default = (configurationInput) => {
    const configuration = {
        ...configurationDefaults,
        ...configurationInput,
    };
    const server = configuration.server;
    const sockets = new Set();
    const secureSockets = new Set();
    let terminating;
    server.on('connection', (socket) => {
        if (terminating) {
            log.info("Destroying newly requested HTTP socket because server is terminating");
            socket.destroy();
        }
        else {
            sockets.add(socket);
            socket.once('close', () => {
                sockets.delete(socket);
            });
        }
    });
    server.on('secureConnection', (socket) => {
        if (terminating) {
            log.info("Destroying newly requested HTTPS socket because server is terminating");
            socket.destroy();
        }
        else {
            secureSockets.add(socket);
            socket.once('close', () => {
                secureSockets.delete(socket);
            });
        }
    });
    /**
     * Evaluate whether additional steps are required to destroy the socket.
     *
     * @see https://github.com/nodejs/node/blob/57bd715d527aba8dae56b975056961b0e429e91e/lib/_http_client.js#L363-L413
     */
    const destroySocket = (socket) => {
        socket.destroy();
        if (socket.server instanceof http_1.default.Server) {
            sockets.delete(socket);
        }
        else {
            secureSockets.delete(socket);
        }
    };
    const terminate = async () => {
        if (terminating) {
            log.warn('already terminating HTTP server');
            return terminating;
        }
        let resolveTerminating;
        let rejectTerminating;
        terminating = new Promise((resolve, reject) => {
            resolveTerminating = resolve;
            rejectTerminating = reject;
        });
        server.on('request', (incomingMessage, outgoingMessage) => {
            if (!outgoingMessage.headersSent) {
                log.info("Adding connection-close to response associated with request incoming on already connected socket");
                outgoingMessage.setHeader('connection', 'close');
            }
        });
        log.info(`There are ${sockets.size} open HTTP sockets and ${secureSockets.size} open HTTPS sockets`);
        for (const socket of sockets) {
            // This is the HTTP CONNECT request socket.
            // @ts-expect-error Unclear if I am using wrong type or how else this should be handled.
            if (!(socket.server instanceof http_1.default.Server)) {
                continue;
            }
            // @ts-expect-error Unclear if I am using wrong type or how else this should be handled.
            const serverResponse = socket._httpMessage;
            if (serverResponse) {
                if (!serverResponse.headersSent) {
                    serverResponse.setHeader('connection', 'close');
                }
                continue;
            }
            log.info("Destroying HTTP socket because no _httpMessage assigned to it");
            destroySocket(socket);
        }
        for (const socket of secureSockets) {
            // @ts-expect-error Unclear if I am using wrong type or how else this should be handled.
            const serverResponse = socket._httpMessage;
            if (serverResponse) {
                if (!serverResponse.headersSent) {
                    serverResponse.setHeader('connection', 'close');
                }
                continue;
            }
            log.info("Destroying HTTPS socket because no _httpMessage assigned to it");
            destroySocket(socket);
        }
        // Wait for all in-flight connections to drain, forcefully terminating any
        // open connections after the given timeout
        try {
            await (0, p_wait_for_1.default)(() => {
                return sockets.size === 0 && secureSockets.size === 0;
            }, {
                interval: 10,
                timeout: configuration.gracefulTerminationTimeout,
            });
        }
        catch (_a) {
            // Ignore timeout errors
        }
        finally {
            for (const socket of sockets) {
                log.info("Destroying HTTP socket because timeout has been reached");
                destroySocket(socket);
            }
            for (const socket of secureSockets) {
                log.info("Destroying HTTPS socket because timeout has been reached");
                destroySocket(socket);
            }
        }
        server.close((error) => {
            if (error) {
                rejectTerminating(error);
            }
            else {
                resolveTerminating();
            }
        });
        return terminating;
    };
    return {
        secureSockets,
        sockets,
        terminate,
    };
};
