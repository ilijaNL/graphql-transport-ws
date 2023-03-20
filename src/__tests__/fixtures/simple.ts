import { ErrorMessage, NextMessage } from '../../common';
import { ServerOptions } from '../../server';

// use for dispatching a `pong` to the `ping` subscription
const pendingPongs: Record<string, number | undefined> = {};
const pongListeners: Record<string, ((done: boolean) => void) | undefined> = {};
export function pong(key = 'global'): void {
  if (pongListeners[key]) {
    pongListeners[key]?.(false);
  } else {
    const pending = pendingPongs[key];
    pendingPongs[key] = pending ? pending + 1 : 1;
  }
}

export const emptySubscribe: ServerOptions['createSubscription'] = () => {
  return {
    start: () => Promise.resolve(),
    stop() {
      //
    },
  };
};

export const GET_VALUE_QUERY = 'query { getValue }';
export const PING_SUB = 'subscription { ping }';
export const LATE_SUB = 'subscription { lateReturn }';
export const GREETINGS = 'subscription { greetings }';

async function getValue(
  emit: (message: NextMessage['payload']) => Promise<void>,
) {
  await emit({ data: { getValue: 'value' } });
}

export const simpleSubscribe: ServerOptions['createSubscription'] = ({
  message,
}) => {
  if (message.payload.query === GET_VALUE_QUERY) {
    return {
      start(emit) {
        return getValue(emit);
      },
      stop() {
        //
      },
    };
  }

  if (message.payload.query === 'subscription { greetings }') {
    const iter = (async function* () {
      for (const hi of ['Hi', 'Bonjour', 'Hola', 'Ciao', 'Zdravo']) {
        yield { greetings: hi };
      }
    })();

    return {
      start: async function (emit) {
        for await (const l of iter) {
          await emit({ data: { greetings: l } });
        }
      },
      stop: () => {
        iter.return(undefined);
      },
    };
  }

  if (message.payload.query === PING_SUB) {
    const vars = message.payload.variables as Record<string, string>;
    const key = vars?.key !== undefined ? vars.key : 'global';

    const iterator: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if ((pendingPongs[key] ?? 0) > 0) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          pendingPongs[key]!--;
          return { value: 'pong' };
        }
        if (await new Promise((resolve) => (pongListeners[key] = resolve)))
          return { done: true, value: null };
        return { value: 'pong' };
      },
      async return() {
        pongListeners[key]?.(true);
        delete pongListeners[key];
        return { done: true, value: null };
      },
      async throw() {
        throw new Error('Ping no gusta');
      },
    };

    return {
      start: async function (emit) {
        for await (const l of iterator) {
          await emit({ data: { ping: l } });
        }
      },
      stop: () => {
        iterator.return?.(undefined);
      },
    };
  }

  if (message.payload.query === LATE_SUB) {
    let completed = () => {
      // noop
    };
    const iterator = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        await new Promise<void>((resolve) => (completed = resolve));
        return { done: true, value: null };
      },
      return(_value: unknown) {
        completed();

        // resolve return in next tick so that the generator loop breaks first
        return new Promise<{ done: true; value: null }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: null }), 0),
        );
      },
    };

    return {
      start: async function (emit) {
        for await (const l of iterator) {
          await emit({ data: { ping: l } });
        }
      },
      stop: () => {
        iterator.return(undefined);
      },
    };
  }

  return {
    stop: () => {
      //
    },
    start: () =>
      Promise.resolve<ErrorMessage['payload']>([
        { message: 'unknown', name: 'operation not known' },
      ]),
  };
};
