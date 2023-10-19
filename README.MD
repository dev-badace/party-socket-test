# party-socket-test

**Note**:- This is somewhat experimental at this point, so don't use it in production,
**party-socket-test** is a reconnecting websocket class, with **more accuracy**, allows Ping/Pong , intended to be used with [partykit](https://www.partykit.io/)

### installation

    npm i party-socket-test

### basic usage

client side

    import {PartySocket} from 'party-socket-test'

    const socket  = new PartySocket({
      host: "localhost:1999",
      room: "boba",
      logLevel: 0, //listen to all logs
    });

    //starts the connection engine
    socket.start()

    //similar to .addEventlistenr("message")
    sock.eventHub.messages.subscribe((message)  =>  {
        // console.log(message.data);
    });

    //closes the socket
    socket.close()

    //reconnects, this will drop the current connection if there is one
    socket.reconnect()

    //closes the socket if any, stops the engine, no further messages accepted
    //till .start()  is called again
    socket.stop()

server side

     import { Connection, Server } from "partykit/server";

     export default class Playground implements Server {
        onMessage(
          message: string | ArrayBuffer,
          sender: Connection<unknown>
        ) {
          //send pong for ping
          if (message === "PING") {
             sender.send("PONG");
          }
       }
     }

### auth

    new PartySocket({
      host: "localhost:1999", //the host
      room: "boba", //room name/id

      auth: async () => {
        return {

           //data will be included in query that is sent to the server
           //similar to how partysocket works
           data: {token: "heheheheh"}

           host: "new host" //this will override the one in config
           room: "new room" //this will override the one in config
        }
      }
    });

### config

    new PartySocket({
      host: "localhost:1999", //the host
      room: "boba", //room name/id
      logLevel:  3,  //logs 0 , 1 , 2, 3, defaults is none
      config:  {

        //the time to wait for auth to resolve
        authTimeout:  20000,  //20 seconds, default is 10sec

        //the backoff after each unsucessful auth try
        authBackoff:  [250,  500,  1000,  2000,  5000],  //default is [250, 500, 1000, 5000]

        //the time to wait for socket connection
        socketConnectTimeout:  20000,  //20seconds, default is 10sec

        //the backoff after each unsucessful connection try
        connectionBackoff:  [250,  500,  1000,  2000,  5000],  //default is [250, 500, 1000, 5000]

        //the interval for ping/pong
        heartbeatInterval:  10000,  //10seconds, default is 30 seconds

        //max auth tries after consecutive failure,
        maxAuthTries:  10,  //default is 5

        //max connection tries after consecutive failure,
        maxConnTries:  10,  //default is 5
      },
    });

//docs are incomplete there are some other config methods...
