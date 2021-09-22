/* eslint-disable import/order */

import http from 'http';
import waitFor from 'p-wait-for';
import type {
  Duplex,
} from 'node:stream';
import Logger from '../Logger';
import type {
  HttpTerminatorConfigurationInput,
  InternalHttpTerminator,
} from '../types';

const log = Logger.child({
  namespace: 'createHttpTerminator',
});

const configurationDefaults = {
  gracefulTerminationTimeout: 1_000,
};

export default (
  configurationInput: HttpTerminatorConfigurationInput,
): InternalHttpTerminator => {
  const configuration = {
    ...configurationDefaults,
    ...configurationInput,
  };

  const server = configuration.server;

  const sockets = new Set<Duplex>();
  const secureSockets = new Set<Duplex>();

  let terminating;

  server.on('connection', (socket) => {
    if (terminating) {
      console.log("[http-terminator] Destroying newly requested HTTP socket because server is terminating")
      socket.destroy();
    } else {
      sockets.add(socket);

      socket.once('close', () => {
        sockets.delete(socket);
      });
    }
  });

  server.on('secureConnection', (socket) => {
    if (terminating) {
      console.log("[http-terminator] Destroying newly requested HTTPS socket because server is terminating")
      socket.destroy();
    } else {
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

    if (socket.server instanceof http.Server) {
      sockets.delete(socket);
    } else {
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
        console.log("[http-terminator] Adding connection-close to response associated with request incoming on already connected socket")
        outgoingMessage.setHeader('connection', 'close');
      }
    });

    console.log(`[http-terminator] There are ${sockets.size} open HTTP sockets and ${secureSockets.size} open HTTPS sockets`)

    for (const socket of sockets) {
      // This is the HTTP CONNECT request socket.
      // @ts-expect-error Unclear if I am using wrong type or how else this should be handled.
      if (!(socket.server instanceof http.Server)) {
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
      console.log("[http-terminator] Destroying HTTP socket because no _httpMessage assigned to it")
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

      console.log("[http-terminator] Destroying HTTPS socket because no _httpMessage assigned to it")
      destroySocket(socket);
    }

    // Wait for all in-flight connections to drain, forcefully terminating any
    // open connections after the given timeout
    try {
      await waitFor(() => {
        return sockets.size === 0 && secureSockets.size === 0;
      }, {
        interval: 10,
        timeout: configuration.gracefulTerminationTimeout,
      });
    } catch {
      // Ignore timeout errors
    } finally {
      for (const socket of sockets) {
        console.log("[http-terminator] Destroying HTTP socket because timeout has been reached")
        destroySocket(socket);
      }

      for (const socket of secureSockets) {
        console.log("[http-terminator] Destroying HTTPS socket because timeout has been reached")
        destroySocket(socket);
      }
    }

    server.close((error) => {
      if (error) {
        rejectTerminating(error);
      } else {
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
