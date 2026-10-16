import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { expect,test,type Page } from '@playwright/test';
import type { Scenario } from './shared-business-profile-fixture';
const built=buildSync({entryPoints:[fileURLToPath(new URL('./shared-business-profile-fixture.tsx',import.meta.url))],bundle:true,write:false,outdir:'out',format:'iife',platform:'browser',jsx:'automatic',nodePaths:[fileURLToPath(new URL('../../node_modules',import.meta.url))]});
async function render(page:Page,scenario:Scenario){
 await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>');
 await page.evaluate(value=>{(window as Window&{businessScenario:Scenario}).businessScenario=value;},scenario);
 for(const file of built.outputFiles)if(file.path.endsWith('.css'))await page.addStyleTag({content:file.text});
 for(const file of built.outputFiles)if(file.path.endsWith('.js'))await page.addScriptTag({content:file.text});
}
test('edits contact email only when the server authorizes the safe shared profile',async({page})=>{
 await render(page,'enabled');await expect(page.getByLabel('Contact email')).toBeEditable();
 await page.getByLabel('Contact email').fill('changed@example.test');
 const bounds=await page.getByLabel('Contact email').boundingBox();expect(bounds&&bounds.x>=0&&bounds.x+bounds.width<=page.viewportSize()!.width).toBeTruthy();
 await page.getByRole('button',{name:'Save business profile'}).click();await expect(page.getByText('Saved. Updates to connected systems are processing.')).toBeVisible();
 await expect(page.getByLabel('Contact email')).toBeDisabled();
 const calls=await page.evaluate(()=>(window as Window&{businessCalls:string[]}).businessCalls);
 expect(calls).toHaveLength(1);expect(JSON.parse(calls[0]!).profile.email).toBe('changed@example.test');
});
test('retries an unknown save with the same frozen mutation and fields',async({page})=>{
 await render(page,'unknown');await page.getByLabel('Name',{exact:true}).fill('Updated Client');await page.getByRole('button',{name:'Save business profile'}).click();
 await expect(page.getByRole('button',{name:'Retry same change'})).toBeVisible();await expect(page.getByLabel('Name',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Retry same change'}).click();await expect(page.getByText('Saved. Updates to connected systems are processing.')).toBeVisible();
 const calls=await page.evaluate(()=>(window as Window&{businessCalls:string[]}).businessCalls);expect(calls).toHaveLength(2);expect(calls[0]).toBe(calls[1]);
});
test('requires refresh after a concurrent profile or access change',async({page})=>{
 await render(page,'conflict');await page.getByRole('button',{name:'Save business profile'}).click();
 await expect(page.getByText('Your profile or access changed. Refresh before making another change.')).toBeVisible();await expect(page.getByRole('button',{name:'Retry same change'})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Refresh profile'})).toBeVisible();
});
test('does not offer a write while PA acknowledgements or authorization are pending',async({page})=>{
 await render(page,'read-only');await expect(page.getByLabel('Contact email')).toBeDisabled();await expect(page.getByRole('button',{name:'Save business profile'})).toHaveCount(0);
});
test('hides profiles that were not granted to this portal account',async({page})=>{
 await render(page,'not-authorized');await expect(page.getByRole('region',{name:'Business profile'})).toHaveCount(0);
});
