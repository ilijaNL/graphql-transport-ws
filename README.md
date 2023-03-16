# Graphql-Ws-gqless

## Getting started

#### Install

```shell
yarn add @ilijanl/graphql-ws-graphqless
```

A fork of graphql-ws. This package is meant to be used for custom executions based on graphql-ws protocol. If used for graphql, go with original graphql-ws package.

All credits go to @enisdenjo

## Create own subscription server

```ts
import { WebSocketServer } from 'ws'; // yarn add ws
// import ws from 'ws'; yarn add ws@7
// const WebSocketServer = ws.Server;
import { useServer } from '@ilijanl/graphql-ws-graphqless/lib/use/ws';
import { schema } from './previous-step';

const server = new WebSocketServer({
  port: 4000,
  path: '/path',
});

useServer(
  {
    createSubscription: () => {
      const iter = (async function* () {
        for (const hi of ['Hi', 'Bonjour', 'Hola', 'Ciao', 'Zdravo']) {
          yield { greetings: hi };
        }
      })();

      return {
        start: async function (emit) {
          for await (const l of iter) {
            await emit({
              id: message.id,
              payload: { data: { greetings: l } },
              type: MessageType.Next,
            });
          }
        },
        stop: () => {
          iter.return(undefined);
        },
      };
    },
  },
  server,
);

console.log('Listening to port 4000');
```
