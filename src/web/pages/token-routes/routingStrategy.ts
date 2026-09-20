import { tr } from '../../i18n.js';
import type { RouteRoutingStrategy } from './types.js';

export function normalizeRouteRoutingStrategyValue(value?: RouteRoutingStrategy | null): RouteRoutingStrategy {
  if (value === 'round_robin' || value === 'stable_first') return value;
  return 'weighted';
}

export function getRouteRoutingStrategyLabel(value?: RouteRoutingStrategy | null): string {
  const strategy = normalizeRouteRoutingStrategyValue(value);
  if (strategy === 'round_robin') return tr('轮询');
  if (strategy === 'stable_first') return tr('稳定优先');
  return tr('权重随机');
}

export function getRouteRoutingStrategyDescription(value?: RouteRoutingStrategy | null): string {
  const strategy = normalizeRouteRoutingStrategyValue(value);
  if (strategy === 'round_robin') {
    return tr('全局调用顺序依次轮换，不看 P 值（不作硬优先级主备区分）；连续失败后进入冷却');
  }
  if (strategy === 'stable_first') {
    return tr('优先避让失败或不健康候选，在稳定池按轮询顺位依次轮换；P 值表示顺位参考');
  }
  return tr('P 值是优先级层级，优先使用最高可用层；同层结合权重、成本和健康度综合选择');
}

export function getRouteRoutingStrategyHint(value?: RouteRoutingStrategy | null): string {
  const strategy = normalizeRouteRoutingStrategyValue(value);
  if (strategy === 'round_robin') {
    return tr('当前策略按全局顺序轮询，不按 P 值区分主备层级；保存后立即生效。');
  }
  if (strategy === 'stable_first') {
    return tr('当前策略优先保障稳定性，异常通道临时避让，稳定通道按顺位轮询；保存后立即生效。');
  }
  return tr('只要更高优先级层级仍有可用通道，后面的层级本次就不会参与选择；保存后立即生效。');
}
