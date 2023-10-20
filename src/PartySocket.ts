import { SingleEventSource } from "./EventSource";
import {
  DEFAULT_AUTH_TIMEOUT,
  type ConnOptions,
  DEFAULT_SOCKET_CONNECT_TIMEOUT,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_CONNECTION_BACKOFF,
  DEFAULT_AUTH_BACKOFF,
  DEFAULT_MAX_CONN_TRIES,
  DEFAULT_MAX_AUTH_TRIES,
  type SocketConfig,
  LogLevel,
} from "./types";
import { awaitPromise, generateUUID } from "./utils";

//* OK what features we want
//* auto reconnecting
//* ping/pong timeouts
//* status & messages
//* manual reconnect
//* manual close
//* handling error events & backoffs

//* [todo] add a proper reset on diconnection & proper connections & counter states

/**
 * Custom error class that can be used to indicate stopping retry operations,
 * such as in authentication and connection resolution.
 * @class
 * @extends {Error}
 */
export class StopRetry extends Error {
  /**
   * Create a new instance of the StopRetry error.
   * @constructor
   * @param {string} msg - The error message.
   */
  constructor(msg: string) {
    super(msg);
  }
}

type ConnState =
  | "initial"
  | "auth"
  | "authError"
  | "connection"
  | "connectionError"
  | "connected"
  | "failed";

//i wonder if cell status is even necessary, i don't see using them or notifying bout them :/
//block statuses are only one that're meaningful and necessary
//cell status hmm...

export class PartySocket {
  private status: "started" | "not_started" = "not_started";
  private stateBlock:
    | "initial"
    | "auth"
    | "authError"
    | "connection"
    | "connectionError"
    | "connected"
    | "failed" = "initial";
  private socket: WebSocket | null = null;
  private connRetry: number = 0;
  private authRetry: number = 0;
  eventHub: {
    messages: SingleEventSource<MessageEvent<any>>;
    status: SingleEventSource<ConnState>; //will update the status of the machine, maybe reqires a helper to get useful states
  };
  private counter = 0;

  //?do we create a message buffer, before resolving the connection, if we give that config option pauseMessageBeforeConnect or something

  constructor(private options: ConnOptions) {
    this.eventHub = {
      messages: new SingleEventSource<MessageEvent<any>>(),
      status: new SingleEventSource<ConnState>(),
    };

    options.config = { ...this.getDefaultSocketConfig(), ...options.config };

    if (!options.userId) {
      options.userId = generateUUID();
    }
  }

  private getDefaultSocketConfig(): SocketConfig {
    return {
      authTimeout: DEFAULT_AUTH_TIMEOUT,
      socketConnectTimeout: DEFAULT_SOCKET_CONNECT_TIMEOUT,
      heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL,
      connectionBackoff: [...DEFAULT_CONNECTION_BACKOFF],
      authBackoff: [...DEFAULT_AUTH_BACKOFF],
      maxConnTries: DEFAULT_MAX_CONN_TRIES,
      maxAuthTries: DEFAULT_MAX_AUTH_TRIES,
    };
  }

  //todo maybe add the counter to the logs, will make it easier to detect versions
  private _log(logLevel: LogLevel, counter: number, ...args: unknown[]) {
    if (typeof this.options.logLevel === "number") {
      if (logLevel < this.options.logLevel) return;

      // not using spread because compiled version uses Symbols
      // tslint:disable-next-line
      console.log.apply(console, [`PWS ${counter} >`, ...args]);
    }
  }

  //these socket event listeners are safe tbh, why?
  //cuz sockets are almost always closed first before trying an reconn
  //saying this in context of them emitting for an old socket, and affecting the new one
  private onSocketError = (event: Event) => {
    this._log(LogLevel.WARN, this.counter, `[Socket internal error]`, event);

    if (this.socket?.readyState === 1) return;

    // this.counter++;
    // this.authentication();
    //now this remains safe
    //since the counter++ events also change the stateBlock
    //honestly we can let ping/pong decide it, but the accuracy drops to the heartbeat interval
    // we try reconnect, on our side, if it's anything other than connected we don't do anything
    if (this.stateBlock === "connected") {
      this.closeSocket();
      this.counter++;
      this.authentication();
    }
  };

  private onSocketClose = (event: CloseEvent) => {
    this._log(LogLevel.WARN, this.counter, `[Socket internal close]`, event);

    //our signal to stop retry
    if (event.code === 4000) {
      this.counter++;
      this.stateBlock = "initial";
      return;
    }

    // we try reconnect, on our side, if it's anything other than connected we don't do anything
    if (this.stateBlock === "connected") {
      this.closeSocket();
      this.counter++;
      this.authentication();
    }
  };

  private onSocketMessage = (event: MessageEvent<any>) => {
    this._log(LogLevel.INFO, this.counter, `[Socket Message]`);
    this._log(LogLevel.DEBUG, this.counter, `[Message Data]`, event);
    this.eventHub.messages.notify(event);
  };

  private tryHeartbeat = () => {
    if (this.stateBlock === "connected") {
      this._log(
        LogLevel.INFO,
        this.counter,
        `[Manual Heartbeat] offline or focus`
      );

      //this will lead to 2 pings temporarily
      //the counter is being guarded by the status, so maybe after some proper fuzz testing we may be able to find bugs,
      //i feel like a race condition can trigger here, maybe n  ot, just the feeling in strong

      //single use ping
      this.ping(this.counter, this.socket!, true);
    }
  };

  private buildUrl({
    host: rawHost,
    room,
    userId,
    protocol,
    data,
    party,
  }: {
    host: string;
    room: string;
    userId: string;
    protocol?: string;
    data: Record<string, string>;
    party?: string;
  }) {
    // strip the protocol from the beginning of `host` if any
    const host = rawHost.replace(/^(http|https|ws|wss):\/\//, "");

    let url = `${
      protocol ||
      (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")
        ? "ws"
        : "wss")
    }://${host}/${party ? `parties/${party}` : "party"}/${room}`;
    if (data) {
      url += `?${new URLSearchParams({ ...data, userId }).toString()}`;
    } else {
      url += `?_pk=${userId}`;
    }

    return url;
  }

  //block
  private async authentication() {
    this.stateBlock = "auth";
    this.eventHub.status.notify(this.stateBlock);
    const localCounter = this.counter;
    this._log(LogLevel.INFO, localCounter, `[Authenticating...]`);

    if (typeof this.options.auth === "function") {
      try {
        const params = await awaitPromise(
          this.options.auth(),
          this.options.config!.authTimeout!
        );

        if (this.counter !== localCounter) {
          this._log(
            LogLevel.DEBUG,
            localCounter,
            `[auth ok] but timers don't match, marked as stale`
          );
          return;
        }

        this._log(
          LogLevel.INFO,
          localCounter,
          `[auth ok] moving to -> connection block`
        );

        this.connection(localCounter, params);
      } catch (error) {
        if (this.counter !== localCounter) {
          this._log(
            LogLevel.DEBUG,
            localCounter,
            `[auth failed] but timers don't match, marked as stale`
          );
          return;
        }

        this._log(
          LogLevel.INFO,
          localCounter,
          `[auth failed]  moving to -> error block`
        );

        this.authError(localCounter, error);
      }
    } else {
      this._log(
        LogLevel.INFO,
        localCounter,
        `[no auth] moving to -> connection block`
      );

      this.connection(localCounter, {});
    }
  }

  //cell
  private async authError(counter: number, error: any) {
    this.stateBlock = "authError";
    this.eventHub.status.notify(this.stateBlock);

    if (error instanceof StopRetry) {
      this._log(
        LogLevel.ERROR,
        counter,
        `[Auth Fail] Server said stop retry`,
        error
      );

      //we consider it fail

      this.stateBlock = "failed";
      this.eventHub.status.notify(this.stateBlock);
      this.counter++;
      return;
    }

    //here we can check the backoffs and add delays and stuff to it
    //this is the function
    if (this.authRetry >= this.options.config!.maxAuthTries!) {
      this._log(
        LogLevel.ERROR,
        counter,
        `[Max Auth Tries] moving to -> Authentication Failed`,
        error
      );

      this.stateBlock = "failed";
      this.eventHub.status.notify(this.stateBlock);
      this.counter++;
      return;
    }

    setTimeout(() => {
      if (counter !== this.counter) {
        this._log(LogLevel.DEBUG, counter, `[stale] [Switch -> Auth Block]`);
        return;
      }

      this._log(LogLevel.INFO, counter, `[Switch -> Auth Block]`);

      this.authentication();
    }, this.options.config!.authBackoff![this.authRetry] || 5000);

    this._log(
      LogLevel.INFO,
      counter,
      `[Schedule Reauth ${
        this.options.config!.authBackoff![this.authRetry] || 5000
      }ms]`
    );

    this.authRetry++;
  }

  //block
  private async connection(counter: number, params: any) {
    this.stateBlock = "connection";
    this.eventHub.status.notify(this.stateBlock);
    this.authRetry = 0; //reaching here autoresets the auth , well not the best place i guess ><

    try {
      let conn = await this._connectSocket(
        this.buildUrl({
          host: params?.host || this.options.host,
          room: params?.room || this.options.host,
          userId: this.options.userId!,
          party: this.options.party,
          data: params?.data,
        })
      );

      if (counter !== this.counter) {
        this._log(LogLevel.DEBUG, counter, `[stale] [Connection ok]`);

        conn.close();
        //@ts-ignore
        conn = null; //apparently removes all event listeners,

        //todo cleanup the socket
        return;
      }

      this.socket = conn;

      this._log(
        LogLevel.INFO,
        counter,
        `[Connection ok] moving to -> connected block`
      );
      this.connected(counter, conn);
    } catch (error) {
      if (counter !== this.counter) {
        this._log(LogLevel.DEBUG, counter, `[stale] [Connection fail]`);

        return;
      }

      this._log(
        LogLevel.INFO,
        counter,
        `[Connection fail] moving to -> connection error block`
      );

      this.connectionError(counter, error);
    }
  }

  //helper
  private addSocketEventListeners(socket: WebSocket) {
    socket.addEventListener("message", this.onSocketMessage);
    socket.addEventListener("close", this.onSocketClose);
    socket.addEventListener("error", this.onSocketError);
  }

  //helper
  private removeSocketEventListeners(socket: WebSocket) {
    socket.removeEventListener("message", this.onSocketMessage);
    socket.removeEventListener("close", this.onSocketClose);
    socket.removeEventListener("error", this.onSocketError);
  }

  //helper
  private async _connectSocket(url: string) {
    if (
      this.options.waitForRoom &&
      typeof this.options.connectionResolver !== "function"
    )
      throw new Error(
        "Bad Config, no connectionResolver provided when waitForRoom was to true"
      );
    let con: WebSocket | null = null;
    let connectionResolverRef: (v: any) => void;
    let cleanupRejectRef: (v: any) => void;

    const connectedSock = new Promise<WebSocket>((resolve, reject) => {
      const conn = new WebSocket(url);

      con = conn;

      const connectionResolver = (e: MessageEvent<any>) => {
        if (typeof this.options.connectionResolver === "function") {
          this.options.connectionResolver(e, () => {
            conn.addEventListener("close", cleanupReject);
            conn.removeEventListener("error", cleanupReject);
            conn.removeEventListener("message", connectionResolver);
            resolve(conn);
          });
        }
      };
      connectionResolverRef = connectionResolver;

      const cleanupReject = (e: any) => {
        // console.log(`[]er `, e); // not useful, can't get any code out of it
        conn.removeEventListener("message", this.onSocketMessage);
        reject(conn);
      };

      cleanupRejectRef = cleanupReject;

      conn.addEventListener("open", () => {
        if (!this.options.waitForRoom) {
          conn.removeEventListener("close", cleanupReject);
          conn.removeEventListener("error", cleanupReject);
          resolve(conn);
        }
      });
      conn.addEventListener("close", cleanupReject);
      conn.addEventListener("error", cleanupReject);

      if (
        this.options.waitForRoom &&
        typeof this.options.connectionResolver === "function"
      )
        conn.addEventListener("message", connectionResolver);

      this.addSocketEventListeners(conn);
    });

    try {
      const con = await awaitPromise<WebSocket>(
        connectedSock,
        this.options.config!.socketConnectTimeout!
      );
      return con;
    } catch (error) {
      //The case where the conn is timeout, but the conn succeeds, this will leave a rouge conn
      //given a normal timeout of say 10sec it's higly unlike to happen
      if (con) {
        (con as WebSocket)?.removeEventListener("close", cleanupRejectRef!);

        (con as WebSocket)?.removeEventListener("error", cleanupRejectRef!);

        (con as WebSocket)?.removeEventListener(
          "message",
          connectionResolverRef!
        );

        this.removeSocketEventListeners(con as WebSocket);

        (con as WebSocket)?.close();
      }
      throw error;
    }
  }

  //cell
  private connectionError(counter: number, error: any) {
    this.stateBlock = "connectionError";
    this.eventHub.status.notify(this.stateBlock);

    if (error instanceof StopRetry) {
      this._log(LogLevel.ERROR, counter, `[Stop Retry] Connection Failed`);
      this.stateBlock = "failed";
      this.eventHub.status.notify(this.stateBlock);
      this.counter++;
      return;
    }

    if (this.connRetry >= this.options.config!.maxConnTries!) {
      this._log(
        LogLevel.ERROR,
        counter,
        `[Max Conn Tries] moving to -> Connection Failed`
      );
      this.stateBlock = "failed";
      this.eventHub.status.notify(this.stateBlock);
      this.counter++;
      return;
    }

    setTimeout(() => {
      if (counter !== this.counter) {
        this._log(LogLevel.DEBUG, counter, `[stale] [Switch -> Auth Block]`);
        return;
      }

      this._log(LogLevel.INFO, counter, `[Switch -> Auth Block]`);

      this.authentication();
    }, this.options.config!.connectionBackoff![this.connRetry] || 5000);

    this._log(
      LogLevel.INFO,
      counter,
      `[Schedule Reconnect ${
        this.options.config!.connectionBackoff![this.connRetry] || 5000
      }ms]`
    );

    this.connRetry++;
  }

  //Block
  private async connected(
    counter: number,
    conn: WebSocket,
    fromPong?: boolean
  ) {
    this.stateBlock = "connected";
    if (!fromPong) this.eventHub.status.notify(this.stateBlock);
    if (!fromPong) this.connRetry = 0; //if this is not rebound from ping, that means a new socket just arrived, fresh & healthy, ok i need to stop writing weird comments

    setTimeout(() => {
      //* ok here what's the scenario ?
      //* let's say a reconnect happened
      //* the normal assumption would be that the socket is closed
      //* so we just check the counter every interval/timeout
      //* if the counters off we just clear the intervals & timeouts
      //* and assume that the conn will get taken care of

      if (counter !== this.counter) {
        this._log(LogLevel.DEBUG, counter, `[stale] [CONNECTED PING]`);
        return;
      }
      this.ping(counter, conn);
    }, this.options!.config!.heartbeatInterval!);
  }

  //cell
  //ok lol :< we still need the counter, making this somewhat useless
  //maybe a good thing adding locks to fsm
  //a scenario where we pass this.counter & this.socket ain't possible
  //counter ++ reconnect
  //ping with stale socket & incorrect counter
  //ok maybe we make sure to ping onlt when the state is connected?
  private async ping(counter: number, conn: WebSocket, singleUse?: boolean) {
    this._log(LogLevel.INFO, counter, `[CONNECTED PING]`);

    conn.send("PING");

    const timeout = setTimeout(() => {
      unsub();
      if (counter !== this.counter) {
        this._log(LogLevel.DEBUG, counter, `[stale] [PONG TIMEOUT]`);

        return;
      }

      this._log(
        LogLevel.INFO,
        counter,
        `[PONG TIMEOUT] moving to -> authentication block`
      );

      //cleanup socket
      this.removeConnection(conn);
      this.counter++;
      this.authentication();
    }, 2000);

    const unsub = this.eventHub.messages.subscribe((e) => {
      if (e.data === "PONG") {
        this._log(
          counter === this.counter ? LogLevel.INFO : LogLevel.DEBUG,
          counter,
          counter === this.counter
            ? `[CONNECTED PONG]`
            : `[stale] [Connected Pong]`
        );
        clearTimeout(timeout);
        unsub();

        //still safe counter
        if (counter === this.counter && !singleUse) {
          this.connected(counter, conn, true);
        }
      }
    });
  }

  //helper
  private removeConnection(socket?: WebSocket) {
    if (socket) {
      this.removeSocketEventListeners(socket);
      socket.close();
    }
  }

  //this closes the socket, always called before reauth
  private closeSocket() {
    if (this.socket) {
      this._log(LogLevel.INFO, this.counter, `[Con closed]`);

      this.removeSocketEventListeners(this.socket);
      this.socket.close();
      this.socket = null;
    }
  }

  public start() {
    if (this.status === "started") {
      console.warn(`Conn has already started`);
      return;
    }

    //todo maybe reset all states here, or at in the stop

    this._log(LogLevel.INFO, this.counter, `[STARTED]`);

    this.status = "started";
    this.authentication();

    window.addEventListener("offline", this.tryHeartbeat);
    window.addEventListener("focus", this.tryHeartbeat);

    //? should we try reconnect online, maybe in certain statuses, huh dunno :/
  }

  //only stop if you want to stop the conn
  //reconn won't happen after this
  public stop() {
    if (this.status === "started") {
      this._log(LogLevel.INFO, this.counter, `[STOPPED]`);
      this.status = "not_started";
      this.counter++;
      this.closeSocket();
      this.stateBlock = "initial"; //todo maybe add closed :/
      this.eventHub.status.notify(this.stateBlock);

      window.removeEventListener("offline", this.tryHeartbeat);
      window.removeEventListener("focus", this.tryHeartbeat);
      //whatever pos it's in, we can easily just increase the counter,
      //and the counter guards will take care of stopping themselves
      //we just need to close if any existing con is there

      //ok somehow make sure to cleanup this
      //close the currently ongoing stuff
      //also close the current conneciton if any
    }
  }

  //userland events should increase the counter
  public reconnect() {
    if (this.status !== "started") {
      console.warn(`Cannot reconnect machine is not started`);
      return;
    }

    this._log(LogLevel.INFO, this.counter, `[Reconnect]`);

    if (this.stateBlock === "connected") {
      this.closeSocket();
    }

    this.counter++;
    this.stateBlock = "initial";
    this.eventHub.status.notify(this.stateBlock);
    this.authentication();
  }

  public close() {
    if (this.status !== "started") {
      console.warn(`Cannot close machine is not started`);
      return;
    }

    this._log(LogLevel.INFO, this.counter, `[Close]`);

    if (this.stateBlock === "connected") {
      this.closeSocket();
    }

    this.counter++;
    this.stateBlock = "initial";
    this.eventHub.status.notify(this.stateBlock);
  }

  public getStatus = () => {
    switch (this.stateBlock) {
      case "auth":
      case "authError":
      case "connection":
      case "connectionError":
        return this.counter > 0 ? "reconnecting" : "connecting";

      case "connected":
        return "connected";
      case "failed":
        return "disconnected";
      case "initial":
        return this.counter > 0 ? "closed" : "initial";

      default:
        console.error(`hmm, invalid state, should never happen`);
    }
  };

  // we're not buffering if offline, leaving that to the user,  maybe later we can do it
  public send(data: string) {
    if (this.socket === null) {
      console.warn("[SEND] socket not connected yet", data);
    } else if (this.socket.readyState !== 1 /* WebSocket.OPEN */) {
      console.warn("[SEND] socket no longer open", data);
    } else {
      this.socket.send(data);
    }
  }

  //todo do we want userland addEventListners. or just let them subscribe to message eventSource :/ not sure
  private addEventListener(e: "close" | "error" | "message") {}
}
