import { rollup } from 'rollup';
import { parseUploadDestination } from './rollupPlugins.mjs';

const destination = parseUploadDestination(process.argv.slice(2));

process.env.DEST = destination;

const { default: config } = await import('../rollup.config.mjs');
const bundle = await rollup(config);

try {
  await bundle.write(config.output);
} finally {
  await bundle.close();
}
