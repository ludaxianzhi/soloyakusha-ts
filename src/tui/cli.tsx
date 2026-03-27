#!/usr/bin/env bun
import { withFullScreen } from 'fullscreen-ink';
import { App } from './app.tsx';

const ink = withFullScreen(<App />);

await ink.start();
await ink.waitUntilExit();
