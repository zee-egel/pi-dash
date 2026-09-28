import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import { X, CheckCircle2, AlertTriangle, ArrowUpRight, Box, Play, Square, RotateCw, ScrollText } from 'lucide-react';
import type { Activity, Container, Metric } from '../../../shared/types';
import { bytes, relative } from './api';
export function Status({ value }: { value: string }) { return <span className={`status ${['running', 'healthy', 'succeeded', 'online'].includes(value) ? 'good' : ['unhealthy', 'failed', 'dead'].includes(value) ? 'bad' : 'muted'}`}><i/>{value === 'none' ? 'No healthcheck' : value}</span>; }
export function Empty({ children }: { children: ReactNode }) { return <div className="empty"><Box size={30}/><p>{children}</p></div>; }
export function Skeleton() { return <div className="skeleton-grid">{[0, 1, 2, 3].map(index => <div key={index} className="skeleton"/>)}</div>; }
export function Chart({ history, metric, color = '#82c9a8' }: { history: Metric[]; metric: 'cpu' | 'memoryUsed' | 'temperature' | 'rx'; color?: string }) {
  return <div className="chart" aria-label={`Recent ${metric} history`}><ResponsiveContainer width="100%" height="100%"><AreaChart data={history}>
    <defs><linearGradient id={`fill-${metric}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.24}/><stop offset="100%" stopColor={color} stopOpacity={0}/></linearGradient></defs>
    <Tooltip contentStyle={{ background: '#161b23', border: '1px solid #303741', borderRadius: 8 }} labelFormatter={(_, payload) => payload?.[0]?.payload?.time ? new Date(payload[0].payload.time).toLocaleTimeString() : ''} formatter={value => metric === 'memoryUsed' || metric === 'rx' ? `${bytes(Number(value))}${metric === 'rx' ? '/s' : ''}` : Number(value).toFixed(1)}/>
    <Area type="monotone" dataKey={metric} stroke={color} fill={`url(#fill-${metric})`} strokeWidth={1.7} isAnimationActive={false} connectNulls={false}/>
  </AreaChart></ResponsiveContainer></div>;
}
export function ActivityList({ items }: { items: Activity[] }) { return <div className="activity-list">{items.length ? items.map(item => <div className="activity-row" key={item.id}>
  <span className={`event-icon ${item.level}`}>{item.level === 'error' || item.level === 'warning' ? <AlertTriangle size={15}/> : item.level === 'success' ? <CheckCircle2 size={15}/> : <ArrowUpRight size={15}/>}</span>
  <div><p>{item.message}</p><small>{item.type}</small></div><time title={new Date(item.timestamp).toLocaleString()}>{relative(item.timestamp)}</time>
</div>) : <Empty>No activity yet.</Empty>}</div>; }
export type Action = 'start' | 'stop' | 'restart';
export function Actions({ container, busy, act, logs }: { container: Container; busy: boolean; act: (container: Container, action: Action) => void; logs: (container: Container) => void }) {
  return <div className="actions">
    {container.state !== 'running' ? <button title="Start container" aria-label={`Start ${container.name}`} disabled={busy} onClick={() => act(container, 'start')}><Play size={15}/></button> : <button title="Stop container" aria-label={`Stop ${container.name}`} disabled={busy} onClick={() => act(container, 'stop')}><Square size={14}/></button>}
    <button title="Restart container" aria-label={`Restart ${container.name}`} disabled={busy} onClick={() => act(container, 'restart')}><RotateCw size={15} className={busy ? 'spin' : ''}/></button>
    <button title="View logs" aria-label={`Logs for ${container.name}`} onClick={() => logs(container)}><ScrollText size={16}/></button>
  </div>;
}
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} onCancel={event => { event.preventDefault(); close(); }} aria-label={title}>
    <div className="modal-heading"><h2>{title}</h2><button aria-label="Close dialog" onClick={close}><X size={20}/></button></div>{children}
  </dialog>;
}
