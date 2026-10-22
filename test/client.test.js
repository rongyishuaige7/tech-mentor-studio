import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient } from './client-helper.js';

const { context } = loadClient(() => Promise.resolve(new Response('{}')));
const repair = source => context.repairMermaid(source);

test('Mermaid repair quotes the labels that break the 10.x flowchart parser', () => {
  assert.equal(repair('flowchart TD\n  A[用户] --> B[getUser()]'), 'flowchart TD\n  A[用户] --> B["getUser()"]');
  assert.equal(repair('flowchart TD\n  A[调用 (v2)] --> B'), 'flowchart TD\n  A["调用 (v2)"] --> B');
  assert.equal(repair('flowchart TD\n  A[调用 f(x, y)] --> B'), 'flowchart TD\n  A["调用 f(x, y)"] --> B');
  assert.equal(repair('flowchart TD\n  A -->|读取 (快)| B'), 'flowchart TD\n  A -->|"读取 (快)"| B');
  assert.equal(repair('flowchart TD\n  subgraph one[模块 (一)]\n    A --> B\n  end'), 'flowchart TD\n  subgraph one["模块 (一)"]\n    A --> B\n  end');
  assert.equal(repair('graph LR\n  A[读(1)] --> B[写(2)]'), 'graph LR\n  A["读(1)"] --> B["写(2)"]');
});

test('Mermaid repair leaves valid shapes, quoted labels and other diagram types alone', () => {
  for (const source of [
    'flowchart TD\n  A[(数据库)] --> B[应用]',
    'flowchart TD\n  A["调用 (v2)"] --> B',
    'flowchart TD\n  A{是否通过?} --> B[结束]',
    'flowchart TD\n  A --> B\n  style A fill:#f9f',
    'flowchart TD\n  A --> B\n  classDef hot fill:#f96',
    'flowchart TD\n  A[开始] --> B[结束]',
    'sequenceDiagram\n  A->>B: 读取 (快)',
    'stateDiagram-v2\n  [*] --> A\n  A --> [*]',
    'erDiagram\n  USER ||--o{ ORDER : places',
    'classDiagram\n  class A {\n    +foo()\n  }'
  ]) assert.equal(repair(source), source, source);
});

test('Mermaid repair is idempotent', () => {
  const once = repair('flowchart TD\n  A[用户] --> B[getUser()]\n  C -->|写入 (慢)| D');
  assert.equal(repair(once), once);
  assert.match(once, /B\["getUser\(\)"\]/);
  assert.match(once, /\|"写入 \(慢\)"\|/);
});
