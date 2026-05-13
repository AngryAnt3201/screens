import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InspectValue } from './inspectValue';
import type { Preview } from './types';

describe('InspectValue', () => {
  it('renders a string primitive in green', () => {
    const p: Preview = { kind: 'primitive', type: 'string', value: 'hello' };
    render(<InspectValue preview={p} />);
    const el = screen.getByText('"hello"');
    expect(el).toHaveAttribute('data-type', 'string');
  });

  it('renders a number primitive', () => {
    const p: Preview = { kind: 'primitive', type: 'number', value: '42' };
    render(<InspectValue preview={p} />);
    expect(screen.getByText('42')).toHaveAttribute('data-type', 'number');
  });

  it('renders null and undefined as keywords', () => {
    const { rerender } = render(
      <InspectValue preview={{ kind: 'primitive', type: 'null', value: 'null' }} />,
    );
    expect(screen.getByText('null')).toBeInTheDocument();
    rerender(<InspectValue preview={{ kind: 'primitive', type: 'undefined', value: 'undefined' }} />);
    expect(screen.getByText('undefined')).toBeInTheDocument();
  });

  it('renders an array preview inline', () => {
    const p: Preview = {
      kind: 'array',
      ctor: 'Array(2)',
      path: '$',
      items: [
        { kind: 'primitive', type: 'number', value: '1' },
        { kind: 'primitive', type: 'number', value: '2' },
      ],
    };
    render(<InspectValue preview={p} />);
    expect(screen.getByText(/Array\(2\)/)).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders an object preview with k: v pairs', () => {
    const p: Preview = {
      kind: 'object',
      ctor: 'Object',
      path: '$',
      entries: [
        ['name', { kind: 'primitive', type: 'string', value: 'Ada' }],
        ['age', { kind: 'primitive', type: 'number', value: '36' }],
      ],
    };
    render(<InspectValue preview={p} />);
    expect(screen.getByText(/name/)).toBeInTheDocument();
    expect(screen.getByText('"Ada"')).toBeInTheDocument();
    expect(screen.getByText('36')).toBeInTheDocument();
  });

  it('renders a cyclic marker', () => {
    const p: Preview = { kind: 'cyclic', path: '$.a.b' };
    render(<InspectValue preview={p} />);
    expect(screen.getByText(/\[Circular/)).toBeInTheDocument();
  });

  it('renders a collapsed object with a chevron', () => {
    const p: Preview = { kind: 'collapsed', ctor: 'HTMLElement', path: '$' };
    render(<InspectValue preview={p} />);
    expect(screen.getByText('HTMLElement')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
  });

  it('renders truncated objects with an N-more note', () => {
    const p: Preview = {
      kind: 'object',
      ctor: 'Object',
      path: '$',
      entries: [['x', { kind: 'primitive', type: 'number', value: '1' }]],
      truncated: 7,
    };
    render(<InspectValue preview={p} />);
    expect(screen.getByText(/7 more/)).toBeInTheDocument();
  });
});
