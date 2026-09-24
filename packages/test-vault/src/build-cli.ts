import { writeCrlfFixtures } from './build.ts';

const count = writeCrlfFixtures();
console.log(`wrote ${count} CRLF fixtures`);
