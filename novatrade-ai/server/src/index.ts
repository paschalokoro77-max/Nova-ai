import 'dotenv/config';
import { createStandaloneApp } from './app.ts';

const port = Number(process.env.PORT || 4000);
const { app } = createStandaloneApp();

app.listen(port, () => {
  console.log(`NovaTrade API listening on http://localhost:${port}`);
});
