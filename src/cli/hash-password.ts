/**
 * `pnpm operator:hash-password`: pide la contraseña del operador sin mostrarla y devuelve su
 * hash Argon2id para OPERATOR_PASSWORD_HASH. También acepta la contraseña por una tubería.
 */
import argon2 from 'argon2';
import { stdin, stdout, stderr } from 'node:process';

async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += String(chunk);
    return data.replace(/\r?\n$/, '');
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (key: string) => {
      for (const char of key) {
        if (char === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelado'));
          return;
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

const password = await readHidden('Contraseña del operador: ');
if (password.length < 12) {
  stderr.write('La contraseña debe tener al menos 12 caracteres.\n');
  process.exit(1);
}
const hash = await argon2.hash(password, { type: argon2.argon2id });
stdout.write(`${hash}\n`);
stderr.write('Copia el valor en OPERATOR_PASSWORD_HASH del fichero .env\n');
