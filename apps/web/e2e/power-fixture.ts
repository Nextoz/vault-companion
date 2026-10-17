// M4c3: the fixture itself lives in src/ui/monitors/power-fixture.ts so the PowerMonitor unit test and the e2e
// specs share one source of truth (the app project cannot import from e2e/ — rootDir is src); this re-export
// keeps the './power-fixture.ts' import paths that mock-api.ts and the specs already use.
export { powerFixture } from '../src/ui/monitors/power-fixture.ts';
