// Domande all'utente: testo normale e input nascosto (senza eco).

import readline from 'node:readline';

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  /** @type {readline.Interface | null} */
  let rl = null;
  const lineQueue = [];
  let waiting = null;
  let ended = false;
  const ensure = () => {
    if (rl) return;
    rl = readline.createInterface({ input, terminal: false });
    rl.on('line', (l) => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(l);
      } else lineQueue.push(l);
    });
    rl.on('close', () => {
      ended = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w('');
      }
    });
  };
  const readLine = () =>
    new Promise((resolve) => {
      ensure();
      if (lineQueue.length) return resolve(lineQueue.shift());
      if (ended) return resolve('');
      waiting = resolve;
    });

  return {
    async ask(question) {
      output.write(`${question} `);
      return (await readLine()).trim();
    },
    async confirm(question, { defaultYes = true } = {}) {
      const ans = (await this.ask(`${question} ${defaultYes ? '[S/n]' : '[s/N]'}`)).toLowerCase();
      if (!ans) return defaultYes;
      return ['s', 'si', 'sì', 'y', 'yes'].includes(ans);
    },
    /** Input senza eco. Se lo standard input non è un terminale legge una riga normale. */
    async askHidden(question) {
      if (!input.isTTY || typeof input.setRawMode !== 'function') return this.ask(question);
      if (rl) {
        rl.close();
        rl = null;
      }
      output.write(`${question} `);
      return new Promise((resolve, reject) => {
        let value = '';
        input.setRawMode(true);
        input.resume();
        input.setEncoding('utf8');
        const done = () => {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
        };
        const onData = (chunk) => {
          for (const ch of chunk) {
            if (ch === '\u0003') {
              done();
              return reject(new Error('Interrotto'));
            }
            if (ch === '\r' || ch === '\n') {
              done();
              return resolve(value.trim());
            }
            if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
            else if (ch >= ' ') value += ch;
          }
        };
        input.on('data', onData);
      });
    },
    close() {
      rl?.close();
    },
  };
}
