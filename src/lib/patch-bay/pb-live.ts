import io, { Socket } from 'socket.io-client';
import PatchBay, { PatchBayOptions } from './rtc-patch-bay';

interface PBLiveSession {
  id: string;
  nick: string;
}

class PBLive extends PatchBay {
  private session: PBLiveSession = {};
  private nickFromId: { [id: string]: string } = {};
  private idFromNick: { [nick: string]: string } = {};
  private makeGlobal: boolean;
  private setPageTitle: boolean;
  private video: HTMLVideoElement | null = null;
  private nick: string | null = null;

  constructor(stream: MediaStream | null, opts: PatchBayOptions & { makeGlobal?: boolean; setTitle?: boolean }) {
    const settings: PatchBayOptions = {
      server: opts.server || 'https://patch-bay.glitch.me/',
      room: opts.room || 'patch-bay',
      stream,
    };

    super(settings);

    if (this.session.id) {
      settings.id = this.session.id;
    }

    this.makeGlobal = opts.makeGlobal || true;
    this.setPageTitle = opts.setTitle || true;

    if (this.makeGlobal) {
      window.pb = this;
    }

    this.on('ready', this.handleReady);
    this.on('broadcast', this.processBroadcast);
    this.on('new peer', this.handleNewPeer);
    this.on('stream', this.handleStream);

    window.onbeforeunload = () => {
      this.session.id = this.id;
      this.session.nick = this.nick || '';
      sessionStorage.setItem('pb', JSON.stringify(this.session));
    };

    this.loadFromStorage();
  }

  private loadFromStorage = () => {
    const storedSession = sessionStorage.getItem('pb');
    if (storedSession !== null) {
      this.session = JSON.parse(storedSession);
    }
  };

  private handleReady = () => {
    if (!this.nick) {
      if (this.session.nick) {
        this.setName(this.session.nick);
      } else {
        this.session.id = this.id;
        this.setName(this.session.id);
      }
    }
    console.log(`connected to server ${this.settings.server} with name ${this.settings.id}`);
  };

  private handleNewPeer = (peer: string) => {
    this.nickFromId[peer] = peer;
    this.idFromNick[peer] = peer;

    if (this.nick) {
      this.broadcast({ type: 'update-nick', id: this.id, nick: this.nick });
    }
  };

  private processBroadcast = (data: { type: string; id: string; nick: string; previous?: string }) => {
    if (data.type === 'update-nick') {
      if (data.previous !== data.nick) {
        delete this.idFromNick[this.nickFromId[data.id]];
        this.nickFromId[data.id] = data.nick;
        this.idFromNick[data.nick] = data.id;
        if (data.previous) {
          console.log(`${data.previous} changed to ${data.nick}`);
        } else {
          console.log(`connected to ${data.nick}`);
        }
      }
    }
  };

  private handleStream = (id: string, stream: MediaStream) => {
    console.log('got stream!', id, stream);
    const video = document.createElement('video');
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => {
      video.play();
      this.video = video;
      this.emit('got video', this.nickFromId[id], video);
    });
  };

  initSource = (nick: string, callback: (stream: MediaStream) => void) => {
    this.initConnectionFromId(this.idFromNick[nick], callback);
  };

  list = () => Object.keys(this.idFromNick);

  setName = (nick: string) => {
    this.broadcast({ type: 'update-nick', id: this.id, nick, previous: this.nick });
    this.nick = nick;
    if (this.setPageTitle) {
      document.title = nick;
    }
  };
}

export default PBLive;