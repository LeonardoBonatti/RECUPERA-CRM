// Função serverless da Vercel. O vercel.json reescreve /api/* para cá;
// req.url mantém o caminho original, então o roteador interno funciona igual ao local.
import { handleApi } from '../server/app.js';

export default function handler(req, res) {
  return handleApi(req, res);
}
