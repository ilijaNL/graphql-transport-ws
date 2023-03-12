import { Context, handleProtocols, makeServer } from '../server';
import {
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  CloseCode,
  MessageType,
  parseMessage,
  stringifyMessage,
  ErrorMessage,
  NextMessage,
} from '../common';
import { GET_VALUE_QUERY, PING_SUB, simpleSubscribe } from './fixtures/simple';
import { createTClient, startWSTServer as startTServer } from './utils';

// silence console.error calls for nicer tests overview
const consoleError = console.error;
beforeAll(() => {
  console.error = () => {
    // silence
  };
});
afterAll(() => {
  console.error = consoleError;
});

/**
 * Tests
 */

it('should use a custom JSON message replacer function', async () => {
  const { url } = await startTServer({
    jsonMessageReplacer: (key, value) => {
      if (key === 'type') {
        return 'CONNECTION_ACK';
      }
      return value;
    },
  });

  const client = await createTClient(url);
  client.ws.send(
    stringifyMessage<MessageType.ConnectionInit>({
      type: MessageType.ConnectionInit,
    }),
  );

  await client.waitForMessage(({ data }) => {
    expect(data).toBe('{"type":"CONNECTION_ACK"}');
  });
});

it('should use a custom JSON message reviver function', async () => {
  const { url } = await startTServer({
    jsonMessageReviver: (key, value) => {
      if (key === 'type') {
        return MessageType.ConnectionInit;
      }
      return value;
    },
  });

  const client = await createTClient(url);
  client.ws.send(
    JSON.stringify({
      type: MessageType.ConnectionInit.toUpperCase(),
    }),
  );

  await client.waitForMessage(({ data }) => {
    expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
  });
});

describe('Connect', () => {
  it('should refuse connection and close socket if returning `false`', async () => {
    const { url } = await startTServer({
      onConnect: () => {
        return false;
      },
    });

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForClose((event) => {
      expect(event.code).toBe(CloseCode.Forbidden);
      expect(event.reason).toBe('Forbidden');
      expect(event.wasClean).toBeTruthy();
    });
  });

  it('should acknowledge connection if not implemented, returning `true` or nothing', async () => {
    async function test(url: string) {
      const client = await createTClient(url);
      client.ws.send(
        stringifyMessage<MessageType.ConnectionInit>({
          type: MessageType.ConnectionInit,
        }),
      );
      await client.waitForMessage(({ data }) => {
        expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      });
    }

    // no implementation
    let server = await startTServer();
    await test(server.url);
    await server.dispose();

    // returns true
    server = await startTServer({
      onConnect: () => {
        return true;
      },
    });
    await test(server.url);
    await server.dispose();

    // returns nothing
    server = await startTServer({
      onConnect: () => {
        /**/
      },
    });
    await test(server.url);
  });

  it('should send optional payload with connection ack message', async () => {
    const { url } = await startTServer({
      onConnect: () => {
        return {
          itsa: 'me',
        };
      },
    });

    const client = await createTClient(url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        type: MessageType.ConnectionAck,
        payload: { itsa: 'me' },
      });
    });
  });

  it('should pass in the `connectionParams` through the context and have other flags correctly set', async (done) => {
    const connectionParams = {
      some: 'string',
      with: 'a',
      number: 10,
    };

    const { url } = await startTServer({
      onConnect: (ctx) => {
        expect(ctx.connectionParams).toEqual(connectionParams);
        expect(ctx.connectionInitReceived).toBeTruthy(); // obviously received
        expect(ctx.acknowledged).toBeFalsy(); // not yet acknowledged
        done();
        return true;
      },
    });

    (await createTClient(url)).ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
        payload: connectionParams,
      }),
    );
  });

  it('should close the socket after the `connectionInitWaitTimeout` has passed without having received a `ConnectionInit` message', async () => {
    const { url } = await startTServer({ connectionInitWaitTimeout: 10 });

    await (
      await createTClient(url)
    ).waitForClose((event) => {
      expect(event.code).toBe(CloseCode.ConnectionInitialisationTimeout);
      expect(event.reason).toBe('Connection initialisation timeout');
      expect(event.wasClean).toBeTruthy();
    });
  });

  it('should not close the socket after the `connectionInitWaitTimeout` has passed but the callback is still resolving', async () => {
    const { url } = await startTServer({
      connectionInitWaitTimeout: 10,
      onConnect: () =>
        new Promise((resolve) => setTimeout(() => resolve(true), 20)),
    });

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );
    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
    });

    await client.waitForClose(() => {
      fail('Shouldnt have closed');
    }, 30);
  });

  it('should close the socket if an additional `ConnectionInit` message is received while one is pending', async () => {
    const { url } = await startTServer({
      connectionInitWaitTimeout: 10,
      onConnect: () =>
        new Promise((resolve) => setTimeout(() => resolve(true), 50)),
    });

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    // issue an additional one a bit later
    setTimeout(() => {
      client.ws.send(
        stringifyMessage<MessageType.ConnectionInit>({
          type: MessageType.ConnectionInit,
        }),
      );
    }, 10);

    await client.waitForClose((event) => {
      expect(event.code).toBe(CloseCode.TooManyInitialisationRequests);
      expect(event.reason).toBe('Too many initialisation requests');
      expect(event.wasClean).toBeTruthy();
    });
  });

  it('should close the socket if more than one `ConnectionInit` message is received at any given time', async () => {
    const { url } = await startTServer();

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );
    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
    });

    // random connection init message even after acknowledgement
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForClose((event) => {
      expect(event.code).toBe(CloseCode.TooManyInitialisationRequests);
      expect(event.reason).toBe('Too many initialisation requests');
      expect(event.wasClean).toBeTruthy();
    });
  });
});

describe('Ping/Pong', () => {
  it('should respond with a pong to a ping', async () => {
    const { url } = await startTServer();

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage({
        type: MessageType.Ping,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        type: MessageType.Pong,
      });
    });
  });

  it("should return ping's payload through the pong", async () => {
    const { url } = await startTServer();

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage({
        type: MessageType.Ping,
        payload: { iCome: 'back' },
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        type: MessageType.Pong,
        payload: { iCome: 'back' },
      });
    });
  });

  it('should not react to a pong', async () => {
    const { url } = await startTServer();

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage({
        type: MessageType.Pong,
      }),
    );

    await client.waitForMessage(() => {
      fail('Shouldt have received a message');
    }, 20);

    await client.waitForClose(() => {
      fail('Shouldt have closed');
    }, 20);
  });

  it('should invoke the websocket callback on ping and not reply automatically', async (done) => {
    const payload = { not: 'relevant' };

    const closed = makeServer({
      getSubscription() {
        return {
          start: () => Promise.resolve(),
          stop() {
            //
          },
        };
      },
    }).opened(
      {
        protocol: GRAPHQL_TRANSPORT_WS_PROTOCOL,
        send: () => fail('Shouldnt have responded to a ping'),
        close: () => {
          /**/
        },
        onMessage: (cb) => {
          cb(stringifyMessage({ type: MessageType.Ping, payload }));
        },
        onPing: (pyld) => {
          setImmediate(() => {
            expect(pyld).toEqual(payload);
            closed(1000, '');
            done();
          });
        },
        onPong: () => fail('Nothing shouldve ponged'),
      },
      {},
    );
  });

  it('should invoke the websocket callback on pong', async (done) => {
    const payload = { not: 'relevant' };

    const closed = makeServer({
      getSubscription() {
        return {
          start: () => Promise.resolve(),
          stop() {
            //
          },
        };
      },
    }).opened(
      {
        protocol: GRAPHQL_TRANSPORT_WS_PROTOCOL,
        send: () => Promise.resolve(),
        close: () => {
          /**/
        },
        onMessage: (cb) => {
          cb(stringifyMessage({ type: MessageType.Pong, payload }));
        },
        onPing: () => fail('Nothing shouldve pinged'),
        onPong: (pyld) => {
          setImmediate(() => {
            expect(pyld).toEqual(payload);
            closed(1000, '');
            done();
          });
        },
      },
      {},
    );
  });
});

describe('Subscribe', () => {
  it('should close the socket on request if connection is not acknowledged', async () => {
    const { url } = await startTServer();

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage<MessageType.Subscribe>({
        id: '1',
        type: MessageType.Subscribe,
        payload: {
          operationName: 'NoAck',
          query: `subscription NoAck {}`,
          variables: {},
        },
      }),
    );

    await client.waitForClose((event) => {
      expect(event.code).toBe(CloseCode.Unauthorized);
      expect(event.reason).toBe('Unauthorized');
      expect(event.wasClean).toBeTruthy();
    });
  });

  it('should use the errors returned from `onError`', async () => {
    const error: ErrorMessage = {
      id: '1',
      payload: [
        { name: 't', message: 'Report' },
        { name: 't', message: 'Me' },
      ],
      type: MessageType.Error,
    };
    const { url } = await startTServer({
      onError: (_ctx, _message) => {
        return error;
      },
    });

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      client.ws.send(
        stringifyMessage<MessageType.Subscribe>({
          id: '1',
          type: MessageType.Subscribe,
          payload: {
            query: `query {
              nogql
            }`,
            variables: {},
          },
        }),
      );
    });

    // because onnext changed the result

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Error,
        payload: error.payload,
      });
    });

    await client.waitForClose(() => {
      fail('Shouldt have closed');
    }, 30);
  });

  it('should execute the query of `string` type, "next" the result and then "complete"', async () => {
    const { url } = await startTServer({});

    const client = await createTClient(url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      client.ws.send(
        stringifyMessage<MessageType.Subscribe>({
          id: '1',
          type: MessageType.Subscribe,
          payload: {
            operationName: 'TestString',
            query: GET_VALUE_QUERY,
            variables: {},
          },
        }),
      );
    });

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Next,
        payload: { data: { getValue: 'value' } },
      });
    });

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Complete,
      });
    });
  });

  it('should execute the live query, "next" multiple results and then "complete"', async () => {
    const { url } = await startTServer({
      getSubscription: () => {
        async function* gen() {
          for (const value of ['Hi', 'Hello', 'Sup']) {
            yield {
              getValue: value,
            };
          }
        }

        const generator = gen();

        async function run(emit: (msg: NextMessage) => Promise<void>) {
          for await (const res of generator) {
            emit({
              id: '1',
              payload: { data: res },
              type: MessageType.Next,
            });
          }
        }

        return {
          start: run,
          stop() {
            generator.return(undefined);
          },
        };
      },
    });

    const client = await createTClient(url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      client.ws.send(
        stringifyMessage<MessageType.Subscribe>({
          id: '1',
          type: MessageType.Subscribe,
          payload: {
            operationName: 'TestString',
            query: 'does not matter',
            variables: {},
          },
        }),
      );
    });

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Next,
        payload: { data: { getValue: 'Hi' } },
      });
    });

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Next,
        payload: { data: { getValue: 'Hello' } },
      });
    });

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Next,
        payload: { data: { getValue: 'Sup' } },
      });
    });

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Complete,
      });
    });
  });

  it('should execute the query and "error"', async () => {
    const error: ErrorMessage = {
      id: '1',
      payload: [
        { name: 't', message: 'Report' },
        { name: 't', message: 'Me' },
      ],
      type: MessageType.Error,
    };
    const { url } = await startTServer({
      getSubscription() {
        return {
          start: () =>
            new Promise((resolve) => setTimeout(() => resolve(error), 10)),
          stop() {
            //
          },
        };
      },
    });

    const client = await createTClient(url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      client.ws.send(
        stringifyMessage<MessageType.Subscribe>({
          id: '1',
          type: MessageType.Subscribe,
          payload: {
            operationName: 'TestNoField',
            query: `some random error`,
            variables: {},
          },
        }),
      );
    });

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual(error);
    });

    await client.waitForClose(() => {
      fail('Shouldnt close because of GraphQL errors');
    }, 30);
  });

  it('should execute the subscription and "next" the published payload', async () => {
    const { url } = await startTServer({
      getSubscription: simpleSubscribe,
    });

    const client = await createTClient(url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      client.ws.send(
        stringifyMessage<MessageType.Subscribe>({
          id: '1',
          type: MessageType.Subscribe,
          payload: {
            operationName: 'Greetings',
            query: 'subscription { greetings }',
          },
        }),
      );
    });

    // we say Hi in 5 languages
    for (let i = 0; i < 5; i++) {
      await client.waitForMessage();
    }

    // completed
    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Complete,
      });
    });
  });

  it('should stop dispatching messages after completing a subscription', async () => {
    const server = await startTServer({});

    const client = await createTClient(server.url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      client.ws.send(
        stringifyMessage<MessageType.Subscribe>({
          id: '1',
          type: MessageType.Subscribe,
          payload: {
            query: PING_SUB,
          },
        }),
      );
    });

    server.pong();

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data)).toEqual({
        id: '1',
        type: MessageType.Next,
        payload: { data: { ping: 'pong' } },
      });
    });

    // send complete
    client.ws.send(
      stringifyMessage<MessageType.Complete>({
        id: '1',
        type: MessageType.Complete,
      }),
    );

    await server.waitForComplete();

    server.pong();
    server.pong();
    server.pong();

    await client.waitForMessage(() => {
      fail("Shouldn't have received a message");
    }, 30);
  });

  it('should close the socket on duplicate operation requests', async () => {
    const { url } = await startTServer();

    const client = await createTClient(url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      client.ws.send(
        stringifyMessage<MessageType.Subscribe>({
          id: 'not-unique',
          type: MessageType.Subscribe,
          payload: {
            query: 'subscription { ping }',
          },
        }),
      );
    });

    // try subscribing with a live subscription id
    client.ws.send(
      stringifyMessage<MessageType.Subscribe>({
        id: 'not-unique',
        type: MessageType.Subscribe,
        payload: {
          query: GET_VALUE_QUERY,
        },
      }),
    );

    await client.waitForClose((event) => {
      expect(event.code).toBe(CloseCode.SubscriberAlreadyExists);
      expect(event.reason).toBe('Subscriber for not-unique already exists');
      expect(event.wasClean).toBeTruthy();
    });
  });

  it('should close the socket on duplicate operation requests even if one is still preparing', async () => {
    const { url } = await startTServer({
      getSubscription: () => {
        return {
          start: () =>
            new Promise(() => {
              /* i never resolve, the subscription will be preparing forever */
            }),
          stop() {
            /* */
          },
        };
      },
    });

    const client = await createTClient(url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
      client.ws.send(
        stringifyMessage<MessageType.Subscribe>({
          id: 'not-unique',
          type: MessageType.Subscribe,
          payload: {
            query: GET_VALUE_QUERY,
          },
        }),
      );
    });

    client.ws.send(
      stringifyMessage<MessageType.Subscribe>({
        id: 'not-unique',
        type: MessageType.Subscribe,
        payload: {
          query: GET_VALUE_QUERY,
        },
      }),
    );

    await client.waitForClose((event) => {
      expect(event.code).toBe(CloseCode.SubscriberAlreadyExists);
      expect(event.reason).toBe('Subscriber for not-unique already exists');
      expect(event.wasClean).toBeTruthy();
    });
  });

  it('should call `onComplete` callback when client completes', async (done) => {
    const server = await startTServer({
      onComplete: () => {
        done();
      },
    });

    const client = await createTClient(server.url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
    });

    client.ws.send(
      stringifyMessage<MessageType.Subscribe>({
        id: '1',
        type: MessageType.Subscribe,
        payload: {
          query: PING_SUB,
        },
      }),
    );
    await server.waitForOperation();

    // just to make sure we're streaming
    server.pong();
    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.Next);
    });

    // complete and done
    client.ws.send(
      stringifyMessage<MessageType.Complete>({
        id: '1',
        type: MessageType.Complete,
      }),
    );
  });

  it('should call `onComplete` callback even if socket terminates abruptly', async (done) => {
    const server = await startTServer({
      onComplete: () => {
        done();
      },
    });

    const client = await createTClient(server.url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );

    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.ConnectionAck);
    });

    client.ws.send(
      stringifyMessage<MessageType.Subscribe>({
        id: '1',
        type: MessageType.Subscribe,
        payload: {
          query: PING_SUB,
        },
      }),
    );
    await server.waitForOperation();

    // just to make sure we're streaming
    server.pong();
    await client.waitForMessage(({ data }) => {
      expect(parseMessage(data).type).toBe(MessageType.Next);
    });

    // terminate socket abruptly
    client.ws.terminate();
  });

  it('should respect completed subscriptions even if subscribe operation stalls', async () => {
    let continueSubscribe: (() => void) | undefined = undefined;
    const server = await startTServer({
      getSubscription: () => {
        async function run() {
          await new Promise<void>((resolve) => (continueSubscribe = resolve));
        }

        return {
          start: run,
          stop() {
            //
          },
        };
      },
    });

    const client = await createTClient(server.url);
    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );
    await client.waitForMessage(); // ack

    client.ws.send(
      stringifyMessage<MessageType.Subscribe>({
        id: '1',
        type: MessageType.Subscribe,
        payload: {
          query: PING_SUB,
        },
      }),
    );

    // wait for the subscribe lock
    while (!continueSubscribe) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // send complete
    client.ws.send(
      stringifyMessage<MessageType.Complete>({
        id: '1',
        type: MessageType.Complete,
      }),
    );

    // wait for complete message
    for (const client of server.getClients()) {
      await new Promise<void>((resolve) => {
        const off = client.onMessage(() => {
          off();
          resolve();
        });
      });
    }

    // then continue
    (continueSubscribe as () => void)();

    // emit
    server.pong();

    await client.waitForMessage(() => {
      fail("Shouldn't have received a message");
    }, 30);

    await server.waitForComplete();
  });

  it('should clean up subscription reservations on abrupt errors without relying on close', async (done) => {
    let currCtx: Context;
    makeServer({
      connectionInitWaitTimeout: 0, // defaults to 3 seconds
      getSubscription: ({ ctx }) => {
        currCtx = ctx;
        return {
          start: () => Promise.reject(),
          stop() {
            //
          },
        };
      },
    }).opened(
      {
        protocol: GRAPHQL_TRANSPORT_WS_PROTOCOL,
        send: () => {
          /**/
        },
        close: () => {
          fail("Shouldn't have closed");
        },
        onMessage: async (cb) => {
          await cb(stringifyMessage({ type: MessageType.ConnectionInit }));

          try {
            // will throw because of execute impl
            await cb(
              stringifyMessage({
                id: '1',
                type: MessageType.Subscribe,
                payload: {
                  query: '{ getValue }',
                },
              }),
            );
            fail("Subscribe shouldn't have succeeded");
          } catch {
            // we dont close the connection but still expect the subscriptions to clean up
            expect(Object.entries(currCtx.subscriptions)).toHaveLength(0);
            done();
          }
        },
      },
      {},
    );
  });

  it('should not send a complete message back if the client sent it', async () => {
    const server = await startTServer();

    const client = await createTClient(server.url);

    client.ws.send(
      stringifyMessage({
        type: MessageType.ConnectionInit,
      }),
    );
    await client.waitForMessage(); // MessageType.ConnectionAck

    client.ws.send(
      stringifyMessage({
        id: '1',
        type: MessageType.Subscribe,
        payload: {
          query: 'subscription { lateReturn }',
        },
      }),
    );
    await server.waitForOperation();

    client.ws.send(
      stringifyMessage({
        id: '1',
        type: MessageType.Complete,
      }),
    );
    await server.waitForComplete();

    await client.waitForMessage(() => {
      fail("Shouldn't have received a message");
    }, 20);
  });
});

describe('Disconnect/close', () => {
  it('should report close code and reason to disconnect and close callback after connection acknowledgement', async (done) => {
    const { url, waitForConnect } = await startTServer({
      // 1st
      onDisconnect: (_ctx, code, reason) => {
        expect(code).toBe(4321);
        expect(reason).toBe('Byebye');
      },
      // 2nd
      onClose: (_ctx, code, reason) => {
        expect(code).toBe(4321);
        expect(String(reason)).toBe('Byebye');
        done();
      },
    });

    const client = await createTClient(url);

    client.ws.send(
      stringifyMessage<MessageType.ConnectionInit>({
        type: MessageType.ConnectionInit,
      }),
    );
    await waitForConnect();

    client.ws.close(4321, 'Byebye');
  });

  it('should trigger the close callback instead of disconnect if connection is not acknowledged', async (done) => {
    const { url } = await startTServer({
      onDisconnect: () => {
        fail("Disconnect callback shouldn't be triggered");
      },
      onClose: (_ctx, code, reason) => {
        expect(code).toBe(4321);
        expect(String(reason)).toBe('Byebye');
        done();
      },
    });

    const client = await createTClient(url);

    client.ws.close(4321, 'Byebye');
  });
});

it('should only accept a Set, Array or string in handleProtocols', () => {
  for (const test of [
    {
      in: new Set(['not', 'me']),
      out: false,
    },
    {
      in: new Set(['maybe', 'me', GRAPHQL_TRANSPORT_WS_PROTOCOL + 'nah']),
      out: false,
    },
    {
      in: new Set(['almost', 'next', GRAPHQL_TRANSPORT_WS_PROTOCOL, 'one']),
      out: GRAPHQL_TRANSPORT_WS_PROTOCOL,
    },
    {
      in: [''],
      out: false,
    },
    {
      in: ['123', GRAPHQL_TRANSPORT_WS_PROTOCOL],
      out: GRAPHQL_TRANSPORT_WS_PROTOCOL,
    },
    {
      in: [GRAPHQL_TRANSPORT_WS_PROTOCOL, GRAPHQL_TRANSPORT_WS_PROTOCOL],
      out: GRAPHQL_TRANSPORT_WS_PROTOCOL,
    },
    {
      in: `some, ${GRAPHQL_TRANSPORT_WS_PROTOCOL}   , other-one,third`,
      out: GRAPHQL_TRANSPORT_WS_PROTOCOL,
    },
    {
      in: `no, graphql-TransPort-ws`,
      out: false,
    },
    {
      in: { iAm: 'unacceptable' },
      out: false,
    },
    {
      in: 123,
      out: false,
    },
    {
      in: null,
      out: false,
    },
    {
      in: undefined,
      out: false,
    },
    {
      in: () => {
        // void
      },
      out: false,
    },
  ]) {
    expect(
      // @ts-expect-error for test purposes, in can be different from type
      handleProtocols(test.in),
    ).toBe(test.out);
  }
});
