import 'dotenv/config';
import { createStandaloneApp } from './app.ts';
import { validateProductionEnvironment } from './supabaseAdmin.ts';

if (process.env.NODE_ENV === 'production') {
  validateProductionEnvironment();
}

const port = Number(process.env.PORT || 4000);
const { app } = createStandaloneApp({
  persistPath: process.env.NODE_ENV === 'production' ? null : undefined,
});

app.listen(port, () => {
  console.log(`NovaTrade API listening on http://localhost:${port}`);
});
