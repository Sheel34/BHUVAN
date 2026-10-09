import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{host:'127.0.0.1',port:5173,strictPort:true,open:false}});
await server.listen();server.printUrls();
