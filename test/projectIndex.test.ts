import { summariseSource } from '../src/projectIndex';

describe('summariseSource — TypeScript', () => {
  const source = [
    `import { Order, OrderLine } from './models';`,
    `import * as fs from 'fs';`,
    `const { readFile } = require('node:fs/promises');`,
    ``,
    `export interface Repository {`,
    `  find(id: string): Promise<Order>;`,
    `}`,
    ``,
    `export class OrderRepository implements Repository {`,
    `  async find(id: string): Promise<Order> {`,
    `    return null as any;`,
    `  }`,
    `}`,
    ``,
    `export const total = (lines: OrderLine[]) => lines.length;`,
    `export type Money = number;`,
    `export enum Currency { GBP, USD }`,
    `export function format(m: Money): string { return String(m); }`,
  ].join('\n');

  const file = summariseSource('src/orders.ts', source, 'typescript', 1, source.length);

  it('reads the declarations', () => {
    const named = file.symbols.map(s => `${s.kind}:${s.name}`);
    expect(named).toEqual(expect.arrayContaining([
      'interface:Repository', 'class:OrderRepository', 'function:total',
      'type:Money', 'enum:Currency', 'function:format',
    ]));
  });

  it('records where each one is', () => {
    const repo = file.symbols.find(s => s.name === 'OrderRepository');
    expect(repo?.line).toBe(8);
    expect(repo?.signature).toBe('export class OrderRepository implements Repository {');
    expect(repo?.exported).toBe(true);
  });

  it('reads the imports and what they bring in', () => {
    expect(file.imports).toEqual(expect.arrayContaining(['./models', 'fs', 'node:fs/promises']));
    expect(file.importedNames).toEqual(expect.arrayContaining(['Order', 'OrderLine', 'readFile']));
  });

  it('does not read control flow as a declaration', () => {
    const noisy = summariseSource('a.ts', 'if (x) {\n  for (const y of z) {}\n}', 'typescript', 1, 30);
    expect(noisy.symbols).toEqual([]);
  });
});

describe('summariseSource — other languages', () => {
  it('reads Python', () => {
    const source = [
      'from app.models import Order, Line',
      'import json',
      '',
      'MAX_LINES = 100',
      '',
      'class OrderService:',
      '    def total(self, order):',
      '        return 0',
      '',
      'async def load(path):',
      '    return None',
    ].join('\n');

    const file = summariseSource('app/service.py', source, 'python', 1, source.length);
    expect(file.symbols.map(s => s.name)).toEqual(
      expect.arrayContaining(['MAX_LINES', 'OrderService', 'total', 'load']));
    expect(file.imports).toEqual(expect.arrayContaining(['app.models', 'json']));
    expect(file.importedNames).toEqual(expect.arrayContaining(['Order', 'Line']));
  });

  it('reads Java', () => {
    const source = [
      'package com.shop;',
      'import com.shop.model.Order;',
      '',
      'public class OrderService {',
      '    public Order find(String id) {',
      '        return null;',
      '    }',
      '}',
    ].join('\n');

    const file = summariseSource('src/OrderService.java', source, 'java', 1, source.length);
    expect(file.symbols.map(s => s.name)).toEqual(expect.arrayContaining(['OrderService', 'find']));
    expect(file.imports).toEqual(['com.shop.model.Order']);
    expect(file.importedNames).toEqual(['Order']);
  });

  it('reads Rust', () => {
    const source = [
      'use crate::model::{Order, Line};',
      'use std::fmt;',
      '',
      'pub struct Repo;',
      'pub trait Find { fn find(&self) -> Option<Order>; }',
      'pub async fn load() -> Repo { Repo }',
    ].join('\n');

    const file = summariseSource('src/repo.rs', source, 'rust', 1, source.length);
    expect(file.symbols.map(s => `${s.kind}:${s.name}`)).toEqual(
      expect.arrayContaining(['struct:Repo', 'trait:Find', 'function:load']));
    expect(file.importedNames).toEqual(expect.arrayContaining(['Order', 'Line']));
  });

  it('reads Go', () => {
    const source = [
      'package shop',
      '',
      'type Order struct {',
      '    ID string',
      '}',
      '',
      'func (o *Order) Total() int { return 0 }',
      'func Load(id string) *Order { return nil }',
    ].join('\n');

    const file = summariseSource('shop/order.go', source, 'go', 1, source.length);
    expect(file.symbols.map(s => s.name)).toEqual(expect.arrayContaining(['Order', 'Total', 'Load']));
  });

  it('returns something usable for a language it has no patterns for', () => {
    const file = summariseSource('a.erl', 'whatever.', 'erlang', 1, 9);
    expect(file.symbols).toEqual([]);
    expect(file.language).toBe('erlang');
  });
});

describe('summariseSource — limits', () => {
  it('stops looking for imports past the head of the file', () => {
    const body = Array(200).fill('const x = 1;').join('\n');
    const file = summariseSource('a.ts', `${body}\nimport { Late } from './late';`, 'typescript', 1, 1);
    expect(file.imports).toEqual([]);
  });

  it('skips a minified line rather than trying to parse it', () => {
    const long = 'export const a = ' + '1+'.repeat(300) + '1;';
    const file = summariseSource('a.ts', long, 'typescript', 1, long.length);
    expect(file.symbols).toEqual([]);
  });
});
