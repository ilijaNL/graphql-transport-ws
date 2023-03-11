import {
  ErrorMessage,
  MessageType,
  NextMessage,
  SubscribeMessage,
} from '../../common';
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

export const emptySubscribe: ServerOptions['subscribe'] = () => {
  return {
    waitToResolve: Promise.resolve(),
    cancel() {
      //
    },
  };
};

export const GET_VALUE_QUERY = 'query { getValue }';
export const PING_SUB = 'subscription { ping }';
export const LATE_SUB = 'subscription { lateReturn }';
export const GREETINGS = 'subscription { greetings }';

async function getValue(
  message: SubscribeMessage,
  emit: (message: NextMessage) => Promise<void>,
) {
  await emit({
    id: message.id,
    payload: { data: { getValue: 'value' } },
    type: MessageType.Next,
  });
}

export const simpleSubscribe: ServerOptions['subscribe'] = ({
  message,
  emit,
}) => {
  let waitToResolve: Promise<ErrorMessage | void> =
    Promise.resolve<ErrorMessage>({
      id: message.id,
      payload: [{ message: 'unknown', name: 'operation not known' }],
      type: MessageType.Error,
    });
  let cancelFn = () => {
    /* */
  };

  if (message.payload.query === GET_VALUE_QUERY) {
    waitToResolve = getValue(message, emit);
  }

  if (message.payload.query === 'subscription { greetings }') {
    const iter = (async function* () {
      for (const hi of ['Hi', 'Bonjour', 'Hola', 'Ciao', 'Zdravo']) {
        yield { greetings: hi };
      }
    })();

    waitToResolve = (async function () {
      for await (const l of iter) {
        await emit({
          id: message.id,
          payload: { data: { greetings: l } },
          type: MessageType.Next,
        });
      }
    })();

    cancelFn = () => {
      iter.return(undefined);
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

    waitToResolve = (async function () {
      for await (const l of iterator) {
        await emit({
          id: message.id,
          payload: { data: { ping: l } },
          type: MessageType.Next,
        });
      }
    })();

    cancelFn = () => {
      iterator.return?.(undefined);
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

    const it = iterator[Symbol.asyncIterator]();

    waitToResolve = (async function () {
      for await (const l of it) {
        await emit({
          id: message.id,
          payload: { data: { ping: l } },
          type: MessageType.Next,
        });
      }
    })();

    cancelFn = () => {
      it.return?.(undefined);
    };
  }

  return {
    cancel: cancelFn,
    waitToResolve: waitToResolve,
  };
};
