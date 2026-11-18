import type { ComponentType, SVGProps } from 'react';
import {
  Archive,
  ArrowDownToLine,
  Boxes,
  Check,
  CircleAlert,
  Hammer,
  Lightbulb,
  ListChecks,
  Microscope,
  Pencil,
  RefreshCw,
  Shield,
  ShoppingCart,
  StickyNote,
  Tag,
  TriangleAlert,
  Unlink,
  Upload,
  WifiOff,
  Wrench,
  Flag,
  Star,
  Rocket,
  type LucideProps,
} from 'lucide-react';
import type { LampIcon } from '../lib/utils/status';

export {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Bell,
  BellRing,
  Calendar,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Cloud,
  Columns3,
  Copy,
  Cpu,
  Crown,
  Diff,
  Download,
  ExternalLink,
  Eye,
  File,
  FileDiff,
  FileText,
  Filter,
  Flag,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GripVertical,
  HardDrive,
  History,
  Info,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  ListChecks,
  Lock,
  LogOut,
  MessageSquare,
  Minus,
  Monitor,
  Move,
  Package,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  RotateCcw,
  ScrollText,
  Search,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  StickyNote,
  Tag,
  Trash2,
  TriangleAlert,
  Undo2,
  Unlink,
  Upload,
  User,
  UserPlus,
  Users,
  WifiOff,
  Wrench,
  X,
  Zap,
} from 'lucide-react';

export type IconComponent = ComponentType<LucideProps>;

/** GitHub mark (lucide dropped brand icons). */
export function GithubMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

const LAMP_ICONS: Record<LampIcon, IconComponent> = {
  check: Check,
  pencil: Pencil,
  'arrow-down': ArrowDownToLine,
  alert: TriangleAlert,
  'wifi-off': WifiOff,
  refresh: RefreshCw,
  unlink: Unlink,
  upload: Upload,
};

export function lampIcon(name: LampIcon): IconComponent {
  return LAMP_ICONS[name];
}

const CATEGORY_ICONS: Record<string, IconComponent> = {
  'sticky-note': StickyNote,
  'triangle-alert': TriangleAlert,
  'list-checks': ListChecks,
  'shopping-cart': ShoppingCart,
  lightbulb: Lightbulb,
  microscope: Microscope,
  shield: Shield,
  wrench: Wrench,
  hammer: Hammer,
  boxes: Boxes,
  flag: Flag,
  star: Star,
  rocket: Rocket,
  archive: Archive,
  tag: Tag,
};

export const CATEGORY_ICON_NAMES = Object.keys(CATEGORY_ICONS);

export function CategoryIcon({ name, ...props }: { name: string } & LucideProps) {
  const Icon = CATEGORY_ICONS[name] ?? Tag;
  return <Icon {...props} />;
}

export const AlertIcon = CircleAlert;
