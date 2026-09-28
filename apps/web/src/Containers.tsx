import { useEffect, useRef, useState } from 'react';
import { Search, Pause, Play, Trash2, Terminal, Box } from 'lucide-react';
import type { Container, ContainerDetail } from '../../../shared/types';
import { api, bytes, duration } from './api';
import { Actions, Empty, Modal, Skeleton, Status } from './components';
import type { Action } from './components';
export function ContainerTable({ containers, busy, act, logs, inspect }: { containers: Container[]; busy: string | null; act: (container: Container, action: Action) => void; logs: (container: Container) => void; inspect: (container: Container) => void }) {
  return containers.length ? <div className="table-scroll"><table><thead><tr><th>Container / image</th><th>Status</th><th>CPU</th><th>Memory</th><th>Uptime / restarts</th><th>Ports</th><th>Actions</th></tr></thead><tbody>{containers.map(container => <tr key={container.id}>
    <td><button className="name-button" onClick={() => inspect(container)}><span className="container-icon"><Box size={17}/></span><span><strong>{container.name}</strong><small>{container.image}</small></span></button></td>
    <td><Status value={container.state}/>{container.health !== 'none' && <small><Status value={container.health}/></small>}</td>
    <td className="mono">{container.cpu === null ? '—' : `${container.cpu.toFixed(1)}%`}</td><td className="mono">{bytes(container.memory)}</td>
    <td><span className="mono">{container.state === 'running' ? duration((Date.now() - Date.parse(container.started)) / 1000) : '—'}</span><small>{container.restarts} restarts</small></td>
    <td><span className="port" title={container.ports.join('\n')}>{container.ports[0] ?? '—'}{container.ports.length > 1 ? ` +${container.ports.length - 1}` : ''}</span></td>
    <td><Actions container={container} busy={busy === container.id} act={act} logs={logs}/></td>
  </tr>)}</tbody></table></div> : <Empty>No containers found on this Docker Engine.</Empty>;
}
export function ContainerDetails({ container, close, busy, act, logs }: { container: Container; close: () => void; busy: boolean; act: (container: Container, action: Action) => void; logs: (container: Container) => void }) {
  const [detail, setDetail] = useState<ContainerDetail>(); const [error, setError] = useState('');
  useEffect(() => { let active = true; api<ContainerDetail>(`/containers/${container.id}`).then(value => { if (active) setDetail(value); }).catch(error => { if (active) setError(error.message); }); return () => { active = false; }; }, [container.id, container.state]);
  return <Modal title={container.name} close={close}><div className="detail-body"><div className="split"><Status value={container.state}/><Actions container={container} busy={busy} act={act} logs={logs}/></div>
    {error ? <p className="error">{error}</p> : !detail ? <Skeleton/> : <><dl className="details">{Object.entries({ 'Container ID': detail.id, Image: detail.image, Created: new Date(detail.created).toLocaleString(), Health: detail.health, 'Restart policy': detail.restartPolicy || 'none', Ports: detail.ports.join(', ') || 'None', Networks: detail.networks.join(', '), CPU: container.cpu === null ? '—' : `${container.cpu.toFixed(1)}%`, Memory: `${bytes(container.memory)} / ${bytes(container.memoryLimit)}`, 'Network received / sent': `${bytes(container.rx)} / ${bytes(container.tx)}` }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <h3>Mounts</h3>{detail.mounts.length ? detail.mounts.map((mount, index) => <p className="code-line" key={index}>{mount.destination} <span>{mount.type} · {mount.readOnly ? 'read-only' : 'read-write'}</span></p>) : <p className="muted">No mounts</p>}
      <h3>Environment variable names</h3><p className="muted">Values are never returned by the API.</p><div className="tags">{detail.environmentNames.map((name, index) => <code key={index}>{name}</code>)}</div></>}
  </div></Modal>;
}
export function LogViewer({ container, close }: { container: Container; close: () => void }) {
  const [lines, setLines] = useState(''); const [paused, setPaused] = useState(false); const [tail, setTail] = useState(200);
  const [search, setSearch] = useState(''); const [scroll, setScroll] = useState(true); const [status, setStatus] = useState('Connecting');
  const terminal = useRef<HTMLPreElement>(null); const first = useRef(true);
  useEffect(() => {
    if (paused) return;
    const source = new EventSource(`/api/containers/${container.id}/logs?tail=${first.current ? tail : 0}`);
    first.current = false;
    source.onopen = () => setStatus('Streaming');
    source.addEventListener('log', event => { const chunk = JSON.parse(event.data) as string; setLines(current => (current + chunk).slice(-250_000)); });
    source.addEventListener('end', () => { setStatus('Container stream ended'); source.close(); });
    source.addEventListener('expired', () => { window.dispatchEvent(new Event('session-expired')); source.close(); });
    source.addEventListener('stream-error', () => { setStatus('Docker stream interrupted. Pause and resume to retry.'); source.close(); });
    source.onerror = () => { setStatus('Connection lost — reconnecting'); };
    return () => source.close();
  }, [container.id, paused, tail]);
  useEffect(() => { if (scroll && terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight; }, [lines, scroll]);
  return <Modal title={`${container.name} / logs`} close={close} wide><div className="log-toolbar"><span><Terminal size={16}/>{paused ? 'Paused' : status}</span><div className="search"><Search size={14}/><input aria-label="Filter logs" placeholder="Filter output…" value={search} onChange={event => setSearch(event.target.value)}/></div>
    <select aria-label="Historical log lines" value={tail} onChange={event => { first.current = true; setLines(''); setTail(Number(event.target.value)); }}>{[100, 200, 500, 1000, 2000].map(count => <option key={count} value={count}>{count} lines</option>)}</select>
    <button onClick={() => setPaused(!paused)}>{paused ? <Play size={14}/> : <Pause size={14}/>} {paused ? 'Resume' : 'Pause'}</button><button title="Clear displayed logs" aria-label="Clear displayed logs" onClick={() => setLines('')}><Trash2 size={15}/></button>
  </div><pre className="terminal" ref={terminal}>{search ? lines.split('\n').filter(line => line.toLowerCase().includes(search.toLowerCase())).join('\n') : lines || 'Waiting for log output…'}</pre><div className="log-footer"><label><input type="checkbox" checked={scroll} onChange={event => setScroll(event.target.checked)}/> Auto-scroll</label><span>Docker timestamps · 250 KB display buffer · paused output is skipped</span></div></Modal>;
}
