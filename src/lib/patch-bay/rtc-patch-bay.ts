import io, { Socket } from 'socket.io-client';
import Peer from 'simple-peer';
import { EventEmitter } from 'events';
import { nanoid } from 'nanoid';

export interface PatchBayOptions {
  server: string;
  id?: string;
  stream?: MediaStream | null;
  peerOptions?: Peer.Options;
  room?: string;
}

interface PatchBaySettings {
  shareMediaWhenRequested: boolean;
  shareMediaWhenInitiating: boolean;
  requestMediaWhenInitiating: boolean;
  autoconnect: boolean;
}

interface PeerInfo {
  rtcPeer: Peer.Instance | null;
  initiator: boolean;
}

class PatchBay extends EventEmitter {
  private signaller: Socket;
  private id: string;
  private stream: MediaStream | null;
  private _peerOptions: Peer.Options;
  private _room: string;
  private settings: PatchBaySettings;
  private peers: { [id: string]: PeerInfo };
  private rtcPeers: { [id: string]: PeerInfo};
  private iceServers: RTCIceServer[] | null;
  idFromNick: any;
  nickFromId: {};

  constructor(options: PatchBayOptions) {
    super();
    // Connect to websocket signalling server. TODO: error validation
    this.signaller = io(options.server);
    // Assign unique id to this peer, or use id passed in
    this.id = options.id || nanoid();

    this.idFromNick = {};
    this.nickFromId = {};

    this.stream = options.stream || null;

     // Options to be sent to simple-peer
    this._peerOptions = options.peerOptions || {};
    this._room = options.room || '';

    this.settings = {
      shareMediaWhenRequested: true,
      shareMediaWhenInitiating: false,
      requestMediaWhenInitiating: true,
      autoconnect: false,
    };

    // Object containing ALL peers in room
    this.peers = {};
    // Object containing peers connected via webrtc
    this.rtcPeers = {};
    // Array of ICE servers to use for webrtc connections - null if not set
    this.iceServers = null;

    // Handle messages from signalling server
    this.signaller.on('ready', this._readyForSignalling);
    this.signaller.on('message', this._handleMessage);
    // Received message via websockets to all peers in room
    this.signaller.on('broadcast', this._receivedBroadcast);

    // Emit 'join' event to signalling server
    this.signaller.emit('join', this._room, { uuid: this.id });
    this.signaller.on('new peer', this._newPeer);
  }

  /**
   * Send data to all connected peers via data channels
   * @param {any} data data to send
   * 
   */
  sendToAll = (data: any) => {
    Object.values(this.rtcPeers).forEach((peer) => peer.rtcPeer!.send(data));
  };

  /**
   * Send data to a specific peer
   * @param {string} peerId id of peer
   * @param {any} data data to send
   */
  sendToPeer = (peerId: string, data: any) => {
    const peer = this.rtcPeers[peerId];
    if (peer && peer.rtcPeer) {
      peer.rtcPeer.send(data);
    }
  };

  private sendStream = (stream: MediaStream, remoteNick: string) => {
    const remoteId = this.idFromNick[remoteNick];
    if (!remoteId) {
      console.error(`No peer found with nickname ${remoteNick}`);
      return;
    }

    const remotePeer = this.rtcPeers[remoteId];
    if (!remotePeer) {
      console.error(`No RTC peer found for ${remoteNick} (${remoteId})`);
      return;
    }

    // Create a new peer connection with the stream
    this.initRtcPeer(remoteId, { stream, initiator: true });
  };

  /**
   * Reinitialize all peers
   */
  reinitAll = () => {
    Object.keys(this.rtcPeers).forEach(this.reinitRtcConnection);
  };

  /**
   * Reinitialize a single peer
   * @param {string} id id of peer 
   * @param {Peer.Options} opts - options to be sent to simple-peer 
   */
  private initRtcPeer = (id: string, opts: Peer.Options) => {
    this.emit('new peer', { id });

    let newOptions = { ...opts };
    if (this.iceServers) {
      newOptions.config = { iceServers: this.iceServers };
    }

    if (opts.initiator) {
      if (this.stream && this.settings.shareMediaWhenInitiating) {
        newOptions.stream = this.stream;
      }
      if (this.settings.requestMediaWhenInitiating) {
        newOptions.offerOptions = {
          offerToReceiveVideo: true,
          offerToReceiveAudio: true,
        };
      }
    } else if (this.stream && this.settings.shareMediaWhenRequested) {
      newOptions.stream = this.stream;
    }

    const options = { ...this._peerOptions, ...newOptions };
    const initPeer = {rtcPeer: new Peer(options), initiator: opts.initiator ? true : false};
    this._attachPeerEvents(initPeer.rtcPeer, id);
  };

  /**
   * Reinitialize a single peer 
   * @param {string} id id of peer
   */
  private reinitRtcConnection = async (id: string) => {
    try {
      await this.rtcPeers[id].rtcPeer!.destroy();
      if (!this.stream) throw new Error('No stream available');
      this.initRtcPeer(id, { initiator: true, stream: this.stream });
    } catch (e) {
      console.error('Error reinitializing RTC connection:', e);
    }
  };

  /**
   * New peer connected to signalling server
   * @param {string} peer id of peer 
   */
  private _newPeer = (peer: string) => {
    // Configuration for specified peer.
    // Individual configuration controls whether will receive media from
    // and/or send media to a specific peer.
    this.peers[peer] = { rtcPeer: null, initiator: false };
    this.emit('new peer', peer);
  };

  /**
   * Once the new peer receives a list of connected peers from the server,
   * it creates new simple-peer object for each connected peer
   * @param {string[]} peers list of connected peers
   * @param {RTCIceServer[]} servers list of ice servers
   */
  private _readyForSignalling = ({ peers, servers }: { peers: string[]; servers?: RTCIceServer[] }) => {
    peers.forEach(this._newPeer);

    if (servers) {
      this.iceServers = servers;
    }

    this.emit('ready');
  };

  initConnectionFromId = (id: string, callback: (stream: MediaStream) => void) => {
    const peer = this.rtcPeers[id];
    if (peer) {
      console.log('Already connected to..', id, this.rtcPeers);

      //if this peer was originally only sending a stream (not receiving), recreate connecting but this time two-way
      if (!peer.initiator) {
        this.reinitRtcConnection(id);
      }
    } else {
      this.initRtcPeer(id, { initiator: true });
    }
  };

  private _handleMessage = (data: { type: string; id: string; message: any }) => {
    if (data.type === 'signal') {
      this._handleSignal(data);
    } else {
      this.emit('message', data);
    }
  };

  private _handleSignal = (data: { id: string; message: any }) => {
    const peer = this.rtcPeers[data.id];
    if (!peer) {
      this.initRtcPeer(data.id, { initiator: false });
    }
    peer.rtcPeer!.signal(data.message);
  };

  private _receivedBroadcast = (data: any) => {
    this.emit('broadcast', data);
  };

  broadcast = (data: any) => {
    this.signaller.emit('broadcast', data);
  };

  private _attachPeerEvents = (p: Peer.Instance, _id: string) => {
    p.on('signal', (data) => {
      this.signaller.emit('message', { id: _id, message: data, type: 'signal' });
    });

    p.on('stream', (stream) => {
      this.rtcPeers[_id].rtcPeer!.addStream(stream);
      this.emit('stream', _id, stream);
    });

    p.on('connect', () => {
      this.emit('connect', _id);
    });

    p.on('data', (data) => {
      this.emit('data', { id: _id, data: JSON.parse(data) });
    });

    p.on('close', () => {
      delete this.rtcPeers[_id];
      this.emit('close', _id);
    });

    p.on('error', (err) => {
      console.warn('simple peer error', err);
    });
  };

  _destroy = () => {
    Object.values(this.rtcPeers).forEach((peer) => peer.rtcPeer!.destroy());
    this.signaller.close();
  };
}

export default PatchBay;