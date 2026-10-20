import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',outputDir:'test-results/playwright',timeout:60000,workers:1,reporter:[['list'],['json',{outputFile:'test-results/e2e-results.json'}]],use:{trace:'retain-on-failure'}});
