import { useState, useMemo } from 'react';
import { Download, Upload, Tag, CheckCircle, Sparkles, FileText, Type, Library, X, Zap, RefreshCw, AlertTriangle, User, Search, Wrench, BookOpen, Users, Hash, Dna, ChevronDown, MoreHorizontal, Calendar, Settings } from 'lucide-react';
import { useToast } from '../Toast';
import skullSvg from '../../assets/skull.svg';

// Per-book cost estimate (input ~2000 tokens, output ~1000 tokens)
const MODEL_PRICES = {
  'gpt-5.4-nano':              { input: 0.20, output: 1.25 },
  'gpt-5-nano':                { input: 0.05, output: 0.40 },
  'gpt-5.4-mini':              { input: 0.75, output: 4.50 },
  'gpt-4o-mini':               { input: 0.15, output: 0.60 },
  'gpt-4o':                    { input: 2.50, output: 10.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
};

function estimateCost(modelId, bookCount, callsPerBook = 1) {
  const p = MODEL_PRICES[modelId];
  if (!p || !bookCount) return null;
  const inputCost = (2000 * bookCount * callsPerBook / 1_000_000) * p.input;
  const outputCost = (1000 * bookCount * callsPerBook / 1_000_000) * p.output;
  return inputCost + outputCost;
}

function formatCost(dollars) {
  if (dollars == null) return '';
  if (dollars < 0.005) return '<$0.01';
  if (dollars < 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(2)}`;
}

export function ActionBar({
  logoSvg,
  activeTab,
  navigateTo,
  selectedFiles,
  allSelected = false,
  groups,
  fileStatuses,
  selectedGroupCount = 0,
  totalBookCount = 0,
  onScan,
  onRescan,
  onPipelineRescan,
  onWrite,
  onRename,
  onPush,
  onPull,
  onRefreshCache,
  onFullSync,
  onBulkEdit,
  onBulkCover,
  onOpenRescanModal,
  onCleanupGenres,
  onAssignTagsGpt,
  onFixDescriptions,
  onFixTitles,
  onFixSubtitles,
  onFixAuthors,
  onFixYears,
  onFixSeries,
  onLookupAge,
  onLookupISBN,
  onRunAll,
  onGenerateDna,
  onClassifyAll,
  classifying = false,
  onMetadataResolution,
  resolvingMetadata = false,
  onDescriptionProcessing,
  processingDescriptions = false,
  onClearSelection,
  onSelectAll,
  onScanErrors,
  onAuthorMatch,
  onBatchFix,
  onNavigateToSettings,
  writing,
  pushing,
  scanning,
  cleaningGenres = false,
  assigningTags = false,
  fixingDescriptions = false,
  fixingTitles = false,
  fixingSubtitles = false,
  fixingAuthors = false,
  fixingYears = false,
  fixingSeries = false,
  lookingUpAge = false,
  lookingUpISBN = false,
  runningAll = false,
  generatingDna = false,
  refreshingCache = false,
  hasAbsConnection = false,
  hasOpenAiKey = false,
  forceFresh = false,
  onToggleForceFresh,
  dnaEnabled = true,
  onToggleDna,
  validationStats = null,
  validating = false,
  authorAnalysis = null,
  onSeriesAnalysis,
  analyzingSeries = false,
  seriesAnalysis = null,
  aiModel = 'gpt-5-nano',
  showEnrichMenu = false,
  onToggleEnrichMenu,
}) {
  const toast = useToast();
  const setShowEnrichMenu = (v) => onToggleEnrichMenu?.(typeof v === 'function' ? v(showEnrichMenu) : v);
  const [showValidateMenu, setShowValidateMenu] = useState(false);

  const totalGroupCount = groups.length;
  const selectedCount = allSelected ? totalGroupCount : selectedGroupCount;
  const hasSelection = selectedCount > 0;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isProcessing = scanning || cleaningGenres || assigningTags || fixingDescriptions || fixingTitles || fixingAuthors || fixingYears || fixingSeries || lookingUpAge || lookingUpISBN || runningAll || generatingDna || classifying || resolvingMetadata || processingDescriptions || pushing || validating || analyzingSeries;

  // Dropdown menu item
  const MenuItem = ({ onClick, disabled, active, icon: Icon, children, badge = null, aiCalls = 0 }) => {
    const costStr = aiCalls > 0 ? formatCost(estimateCost(aiModel, selectedCount, aiCalls)) : null;
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) {
            onClick?.();
            setShowEnrichMenu(false);
            setShowValidateMenu(false);
          }
        }}
        disabled={disabled}
        className={`w-full px-3 py-2 text-sm text-left flex items-center gap-2.5 transition-colors ${
          disabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300 hover:bg-neutral-800 hover:text-white'
        } ${active ? 'text-white bg-neutral-800' : ''}`}
      >
        <Icon className={`w-4 h-4 ${active ? 'animate-pulse' : ''}`} />
        <span className="flex-1">{children}</span>
        {aiCalls > 0 && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/15 text-amber-400 text-[10px] font-medium rounded" title="Uses your AI API key">
            {costStr && selectedCount > 0 && <span>{costStr}</span>}
            <span>AI</span>
          </span>
        )}
        {badge !== null && badge > 0 && (
          <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-medium rounded">
            {badge}
          </span>
        )}
      </button>
    );
  };

  const hasValidationIssues = (validationStats && (validationStats.withErrors > 0 || validationStats.withWarnings > 0)) ||
    (authorAnalysis && authorAnalysis.needs_normalization && authorAnalysis.needs_normalization.length > 0) ||
    (seriesAnalysis && seriesAnalysis.total_issues > 0);

  // Pill button — used for both mobile (with labels) and desktop
  const PillBtn = ({ onClick, disabled, active, icon: Icon, label, variant = 'default', badge = null, compact = false }) => {
    const isActive = active;
    const isPrimary = variant === 'primary' && !isActive && !disabled;

    return (
      <button
        onClick={onClick}
        disabled={disabled}
        title={label}
        className={`relative flex items-center gap-1.5 px-3 py-1.5 md:gap-2 md:px-4 md:py-2 rounded-full transition-all text-xs md:text-sm font-medium whitespace-nowrap ${
          isActive
            ? 'bg-neutral-700 text-white md:bg-neutral-800'
            : isPrimary
              ? 'text-white bg-white/10 hover:bg-white/20'
              : disabled
                ? 'text-gray-600 opacity-40 cursor-not-allowed'
                : 'text-gray-400 hover:text-white hover:bg-neutral-800 active:bg-neutral-700'
        }`}
      >
        <Icon className={`w-4 h-4 md:w-5 md:h-5 ${isActive ? 'animate-pulse' : ''}`} />
        {!compact && <span>{label}</span>}
        {badge !== null && badge > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 md:w-5 md:h-5 bg-red-500 text-white text-[9px] md:text-[10px] font-bold rounded-full flex items-center justify-center">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </button>
    );
  };

  // Toggle button with toast feedback
  const ToggleBtn = ({ onClick, enabled, icon: Icon, label, onLabel, offLabel, spinning = false }) => (
    <button
      onClick={() => {
        onClick?.();
        const next = !enabled;
        toast.info(label, next ? (onLabel || `${label} enabled`) : (offLabel || `${label} disabled`), 2000);
      }}
      className={`flex items-center gap-1.5 px-3 py-1.5 md:gap-2 md:px-4 md:py-2 rounded-full transition-all text-xs md:text-sm font-medium whitespace-nowrap ${
        enabled
          ? 'bg-orange-500/20 text-orange-400'
          : 'text-gray-500 hover:text-gray-300 hover:bg-neutral-800 active:bg-neutral-700'
      }`}
      title={enabled ? onLabel : offLabel}
    >
      <Icon className={`w-4 h-4 md:w-5 md:h-5 ${spinning && enabled ? 'animate-spin' : ''}`} />
      <span>{label}</span>
    </button>
  );

  // Enrich dropdown menu (shared between mobile & desktop)
  const enrichMenu = showEnrichMenu && (
    <div className="fixed md:absolute top-auto md:top-full left-3 right-3 md:left-0 md:right-auto mt-1 md:w-72 bg-neutral-900 rounded-xl border border-neutral-800 shadow-xl py-1 z-50 max-h-[70vh] overflow-y-auto">
      {hasOpenAiKey && (
        <>
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600 font-semibold">
            AI Processing
          </div>

          <button
            onClick={(e) => { e.stopPropagation(); onMetadataResolution?.(); setShowEnrichMenu(false); }}
            disabled={!hasSelection || isProcessing}
            className={`w-full px-3 py-2.5 text-left transition-colors ${
              !hasSelection || isProcessing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-800'
            } ${resolvingMetadata ? 'bg-neutral-800' : ''}`}
          >
            <div className="flex items-center gap-2">
              <Type className={`w-4 h-4 text-blue-400 ${resolvingMetadata ? 'animate-pulse' : ''}`} />
              <span className="text-sm text-white font-medium">Metadata Resolution</span>
              <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/15 text-amber-400 text-[10px] font-medium rounded ml-auto">
                {selectedCount > 0 && <span>{formatCost(estimateCost(aiModel, selectedCount, 1))}</span>}
                <span>AI</span>
              </span>
            </div>
            <p className="text-[11px] text-gray-500 mt-0.5 ml-6">Fix titles, subtitles, authors, and series</p>
          </button>

          <button
            onClick={(e) => { e.stopPropagation(); onClassifyAll?.(false); setShowEnrichMenu(false); }}
            disabled={!hasSelection || isProcessing}
            className={`w-full px-3 py-2.5 text-left transition-colors ${
              !hasSelection || isProcessing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-800'
            } ${classifying ? 'bg-neutral-800' : ''}`}
          >
            <div className="flex items-center gap-2">
              <Sparkles className={`w-4 h-4 text-amber-400 ${classifying ? 'animate-pulse' : ''}`} />
              <span className="text-sm text-white font-medium">Classification & Tagging</span>
              <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/15 text-amber-400 text-[10px] font-medium rounded ml-auto">
                {selectedCount > 0 && <span>{formatCost(estimateCost(aiModel, selectedCount, 1))}</span>}
                <span>AI</span>
              </span>
            </div>
            <p className="text-[11px] text-gray-500 mt-0.5 ml-6">Genres, tags, age rating, and DNA in one pass</p>
          </button>

          <button
            onClick={(e) => { e.stopPropagation(); onDescriptionProcessing?.(); setShowEnrichMenu(false); }}
            disabled={!hasSelection || isProcessing}
            className={`w-full px-3 py-2.5 text-left transition-colors ${
              !hasSelection || isProcessing ? 'opacity-40 cursor-not-allowed' : 'hover:bg-neutral-800'
            } ${processingDescriptions ? 'bg-neutral-800' : ''}`}
          >
            <div className="flex items-center gap-2">
              <FileText className={`w-4 h-4 text-cyan-400 ${processingDescriptions ? 'animate-pulse' : ''}`} />
              <span className="text-sm text-white font-medium">Description Processing</span>
              <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/15 text-amber-400 text-[10px] font-medium rounded ml-auto">
                {selectedCount > 0 && <span>{formatCost(estimateCost(aiModel, selectedCount, 1))}</span>}
                <span>AI</span>
              </span>
            </div>
            <p className="text-[11px] text-gray-500 mt-0.5 ml-6">Validate, clean, or generate descriptions</p>
          </button>

          <div className="h-px bg-neutral-800 my-1" />

          <MenuItem onClick={onRunAll} disabled={!hasSelection} active={runningAll} icon={Zap} aiCalls={3}>
            Run All
          </MenuItem>
          <MenuItem onClick={onLookupISBN} disabled={!hasSelection} active={lookingUpISBN} icon={Hash}>
            Lookup ISBN & ASIN
          </MenuItem>
          <MenuItem onClick={onFixYears} disabled={!hasSelection} active={fixingYears} icon={Calendar}>
            Fix Pub Date
          </MenuItem>

          <div className="h-px bg-neutral-800 my-1" />
          <button
            onClick={(e) => { e.stopPropagation(); setShowAdvanced(!showAdvanced); }}
            className="w-full px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600 font-semibold hover:text-gray-400 flex items-center gap-1 transition-colors"
          >
            <ChevronDown className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            Individual Operations
          </button>
          {showAdvanced && (
            <>
              <MenuItem onClick={onFixTitles} disabled={!hasSelection} active={fixingTitles} icon={Type} aiCalls={1}>
                Fix Titles
              </MenuItem>
              <MenuItem onClick={onFixSubtitles} disabled={!hasSelection} active={fixingSubtitles} icon={BookOpen} aiCalls={1}>
                Fix Subtitles
              </MenuItem>
              <MenuItem onClick={onFixAuthors} disabled={!hasSelection} active={fixingAuthors} icon={User} aiCalls={1}>
                Fix Authors
              </MenuItem>
              <MenuItem onClick={onFixSeries} disabled={!hasSelection} active={fixingSeries} icon={Library} aiCalls={1}>
                Fix Series
              </MenuItem>
              <MenuItem onClick={onCleanupGenres} active={cleaningGenres} icon={Tag}>
                Clean Genres
              </MenuItem>
              <MenuItem onClick={onAssignTagsGpt} disabled={!hasSelection} active={assigningTags} icon={Sparkles} aiCalls={1}>
                AI Tags
              </MenuItem>
              <MenuItem onClick={onFixDescriptions} disabled={!hasSelection} active={fixingDescriptions} icon={FileText} aiCalls={1}>
                Fix Descriptions
              </MenuItem>
              <MenuItem onClick={onLookupAge} disabled={!hasSelection} active={lookingUpAge} icon={Users}>
                Lookup Age
              </MenuItem>
              <MenuItem onClick={onGenerateDna} disabled={!hasSelection} active={generatingDna} icon={Dna} aiCalls={1}>
                Generate DNA
              </MenuItem>
            </>
          )}
        </>
      )}
      {!hasOpenAiKey && (
        <MenuItem onClick={onCleanupGenres} active={cleaningGenres} icon={Tag}>
          Clean Genres
        </MenuItem>
      )}
    </div>
  );

  const enrichIsActive = cleaningGenres || assigningTags || fixingDescriptions || fixingTitles || fixingAuthors || fixingYears || fixingSeries || lookingUpAge || lookingUpISBN || runningAll || generatingDna || classifying || resolvingMetadata || processingDescriptions;

  // Shared grid cell style for mobile buttons — equal width, generous tap targets
  const cellStyle = "flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-medium transition-all whitespace-nowrap active:scale-95";

  return (
    <>
      {/* ==================== MOBILE LAYOUT ==================== */}
      <div className="md:hidden px-3 py-2.5">
        <div className="flex items-center gap-3">
          {/* Skull icon — spans both rows */}
          <img src={skullSvg} alt="Audiobook Tagger" className="w-10 h-auto invert opacity-80 flex-shrink-0 self-center" />

          <div className="flex-1 min-w-0 flex flex-col gap-2">
            {/* Row 1: Import | DNA | Settings */}
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={onPull}
                disabled={!hasAbsConnection || isProcessing}
                className={`${cellStyle} ${
                  scanning && !pushing
                    ? 'bg-white/15 text-white'
                    : !hasAbsConnection || isProcessing
                      ? 'text-gray-600 opacity-40 cursor-not-allowed'
                      : 'bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                <Download className={`w-4 h-4 ${scanning && !pushing ? 'animate-pulse' : ''}`} />
                <span>Import</span>
              </button>

              {hasOpenAiKey && onToggleDna ? (
                <button
                  onClick={() => {
                    onToggleDna();
                    toast.info('DNA', !dnaEnabled ? 'DNA tags enabled' : 'DNA tags disabled', 2000);
                  }}
                  className={`${cellStyle} ${dnaEnabled ? 'bg-orange-500/20 text-orange-400' : 'text-gray-500 hover:text-gray-300 hover:bg-neutral-800'}`}
                >
                  <Dna className="w-4 h-4" />
                  <span>DNA</span>
                </button>
              ) : <div />}

              {navigateTo && (
                <button
                  onClick={() => navigateTo('settings')}
                  className={`${cellStyle} text-gray-400 hover:text-white hover:bg-neutral-800`}
                >
                  <Settings className="w-4 h-4" />
                  <span>Settings</span>
                </button>
              )}
            </div>

            {/* Row 2: All | Force | Push (orange) */}
            {totalGroupCount > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {onSelectAll ? (
                  <button
                    onClick={() => {
                      if (allSelected) {
                        onClearSelection?.();
                        toast.info('Selection', 'All books deselected', 2000);
                      } else {
                        onSelectAll?.();
                        toast.info('Selection', `All ${totalGroupCount} books selected`, 2000);
                      }
                    }}
                    className={`${cellStyle} ${allSelected ? 'bg-neutral-700 text-white' : 'text-gray-400 hover:text-white hover:bg-neutral-800'}`}
                  >
                    <CheckCircle className="w-4 h-4" />
                    <span>{allSelected ? 'None' : 'All'}</span>
                  </button>
                ) : <div />}

                {onToggleForceFresh ? (
                  <button
                    onClick={() => {
                      onToggleForceFresh();
                      toast.info('Force', !forceFresh ? 'Re-processing all books' : 'Skipping already processed', 2000);
                    }}
                    className={`${cellStyle} ${forceFresh ? 'bg-orange-500/20 text-orange-400' : 'text-gray-500 hover:text-gray-300 hover:bg-neutral-800'}`}
                  >
                    <RefreshCw className={`w-4 h-4 ${forceFresh ? 'animate-spin' : ''}`} />
                    <span>Force</span>
                  </button>
                ) : <div />}

                <button
                  onClick={onPush}
                  disabled={isProcessing}
                  className={`${cellStyle} ${
                    pushing
                      ? 'bg-orange-600 text-white'
                      : isProcessing
                        ? 'text-gray-600 opacity-40 cursor-not-allowed'
                        : 'bg-orange-500 text-white hover:bg-orange-400'
                  }`}
                >
                  <Upload className={`w-4 h-4 ${pushing ? 'animate-pulse' : ''}`} />
                  <span>Push</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {!hasAbsConnection && (
          <button
            onClick={onNavigateToSettings}
            className="text-xs text-amber-500 hover:text-amber-400 transition-colors mt-2 ml-13"
          >
            Configure ABS connection →
          </button>
        )}
      </div>

      {/* ==================== DESKTOP LAYOUT ==================== */}
      <div className="hidden md:flex px-5 py-3.5 items-center gap-3">
        {/* Full logo */}
        {logoSvg && (
          <img src={logoSvg} alt="Audiobook Tagger" style={{ height: '36px' }} className="invert opacity-90 mr-1 flex-shrink-0" />
        )}

        {/* Desktop nav */}
        {navigateTo && (
          <nav className="flex items-center gap-0.5 bg-neutral-900/50 rounded-full p-1 mr-2 flex-shrink-0">
            <button
              onClick={() => navigateTo('scanner')}
              className={`px-4 py-2 text-sm font-medium rounded-full transition-all flex items-center gap-2 ${
                activeTab === 'scanner' ? 'bg-neutral-800 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Library className="w-4 h-4" />
              Library
            </button>
            <button
              onClick={() => navigateTo('settings')}
              className={`px-4 py-2 text-sm font-medium rounded-full transition-all flex items-center gap-2 ${
                activeTab === 'settings' ? 'bg-neutral-800 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>
          </nav>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1.5">
          <PillBtn onClick={onPull} disabled={!hasAbsConnection || isProcessing} active={scanning && !pushing} icon={Download} label="Import" variant="primary" />

          {totalGroupCount > 0 && (
            <>
              <div className="relative">
                <button
                  onClick={() => { setShowEnrichMenu(!showEnrichMenu); setShowValidateMenu(false); }}
                  disabled={isProcessing}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all text-sm font-medium whitespace-nowrap ${
                    showEnrichMenu || enrichIsActive ? 'bg-neutral-800 text-white' : 'text-gray-400 hover:text-white hover:bg-neutral-800'
                  } ${isProcessing ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <Sparkles className={`w-5 h-5 ${enrichIsActive ? 'animate-pulse' : ''}`} />
                  <span>Enrich</span>
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                {enrichMenu}
              </div>

              <PillBtn onClick={onPush} disabled={isProcessing} active={pushing} icon={Upload} label="Push" />
            </>
          )}

          {!hasAbsConnection && (
            <button onClick={onNavigateToSettings} className="text-xs text-amber-500 hover:text-amber-400 transition-colors ml-2">
              Configure ABS →
            </button>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Desktop toggles */}
        {totalGroupCount > 0 && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="w-px h-6 bg-neutral-800 mx-1" />

            {hasOpenAiKey && onToggleDna && (
              <ToggleBtn onClick={onToggleDna} enabled={dnaEnabled} icon={Dna} label="DNA" onLabel="DNA tags enabled (slower, richer tags)" offLabel="DNA tags disabled (faster)" />
            )}
            {onToggleForceFresh && (
              <ToggleBtn onClick={onToggleForceFresh} enabled={forceFresh} icon={RefreshCw} label="Force" onLabel="Re-processing all books" offLabel="Skipping already processed" spinning />
            )}
            {onSelectAll && (
              <PillBtn
                onClick={() => {
                  if (allSelected) { onClearSelection?.(); toast.info('Selection', 'All books deselected', 2000); }
                  else { onSelectAll?.(); toast.info('Selection', `All ${totalGroupCount} books selected`, 2000); }
                }}
                active={allSelected}
                icon={CheckCircle}
                label={allSelected ? 'Deselect' : 'Select All'}
              />
            )}
          </div>
        )}

        {/* Selection info */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {hasSelection ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-white font-medium">{selectedCount} selected</span>
              <button onClick={onClearSelection} className="p-1 rounded-full hover:bg-neutral-800 text-gray-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <span className="text-sm text-gray-500">{totalGroupCount > 0 ? `${totalGroupCount} books` : ''}</span>
          )}

          {validationStats && validationStats.scanned > 0 && (
            <div className="flex items-center gap-1.5">
              {validationStats.withErrors > 0 && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 text-xs">
                  <AlertTriangle className="w-3 h-3" />{validationStats.withErrors}
                </span>
              )}
              {validationStats.withWarnings > 0 && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 text-xs">
                  <AlertTriangle className="w-3 h-3" />{validationStats.withWarnings}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Click outside to close menus */}
      {(showEnrichMenu || showValidateMenu) && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => {
            setShowEnrichMenu(false);
            setShowValidateMenu(false);
          }}
        />
      )}
    </>
  );
}
