//! Semantic diff of two parsed documents and three-way overlap detection.

use crate::model::{self, Doc, MotorUse, ParamVal, Unk};
use crate::types::*;
use crate::units::{self, render, translate, Kind};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

// ---------------------------------------------------------------------------------------------
// Component matching
// ---------------------------------------------------------------------------------------------

/// Signature of every component in a subtree: type, name and interpreted parameters.
fn subtree_signatures(doc: &Doc, idx: usize, out: &mut HashMap<String, i64>, sign: i64) {
    let c = &doc.comps[idx];
    let mut params: Vec<String> = c
        .params
        .iter()
        .map(|p| format!("{}={}", p.full_key(), p.cmp))
        .collect();
    params.sort();
    *out.entry(format!("{}|{}|{}", c.element, c.name, params.join(";")))
        .or_default() += sign;
    for &ch in &c.children {
        subtree_signatures(doc, ch, out, sign);
    }
}

/// How different two subtrees are (0 = identical); used to choose between identically named
/// candidates.
fn similarity_cost(bd: &Doc, ib: usize, ad: &Doc, ia: usize) -> usize {
    let mut counts: HashMap<String, i64> = HashMap::new();
    subtree_signatures(bd, ib, &mut counts, -1);
    subtree_signatures(ad, ia, &mut counts, 1);
    counts.values().map(|v| v.unsigned_abs() as usize).sum()
}

pub(crate) struct Matching {
    pub b2a: Vec<Option<usize>>,
    pub a2b: Vec<Option<usize>>,
}

fn unique_ids(doc: &Doc) -> HashMap<&str, usize> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for c in &doc.comps {
        if let Some(id) = &c.id {
            *counts.entry(id.as_str()).or_default() += 1;
        }
    }
    let mut out = HashMap::new();
    for (i, c) in doc.comps.iter().enumerate() {
        if let Some(id) = &c.id {
            if counts[id.as_str()] == 1 {
                out.insert(id.as_str(), i);
            }
        }
    }
    out
}

/// Matches components between two versions: by ID if both have one (and it is unique), otherwise
/// by position in the tree (matched parent) + type + name, then a conservative rename heuristic
/// (exactly one unmatched component of that type on each side).
pub(crate) fn match_components(b: &Doc, a: &Doc) -> Matching {
    let mut b2a: Vec<Option<usize>> = vec![None; b.comps.len()];
    let mut a2b: Vec<Option<usize>> = vec![None; a.comps.len()];
    let mut queue: VecDeque<(usize, usize)> = VecDeque::new();

    b2a[0] = Some(0);
    a2b[0] = Some(0);
    queue.push_back((0, 0));

    let ids_b = unique_ids(b);
    let ids_a = unique_ids(a);
    let mut ordered: Vec<(&str, usize)> = ids_b.iter().map(|(k, v)| (*k, *v)).collect();
    ordered.sort_by_key(|(_, i)| *i);
    for (id, ib) in ordered {
        if ib == 0 {
            continue;
        }
        if let Some(&ia) = ids_a.get(id) {
            if ia != 0 && b.comps[ib].element == a.comps[ia].element {
                b2a[ib] = Some(ia);
                a2b[ia] = Some(ib);
                queue.push_back((ib, ia));
            }
        }
    }

    let compat = |ib: usize, ia: usize| -> bool {
        let (cb, ca) = (&b.comps[ib], &a.comps[ia]);
        cb.element == ca.element && !(cb.id.is_some() && ca.id.is_some())
    };

    while let Some((pb, pa)) = queue.pop_front() {
        let bc: Vec<usize> = b.comps[pb]
            .children
            .iter()
            .copied()
            .filter(|c| b2a[*c].is_none())
            .collect();
        let ac: Vec<usize> = a.comps[pa]
            .children
            .iter()
            .copied()
            .filter(|c| a2b[*c].is_none())
            .collect();
        let mut new_pairs: Vec<(usize, usize)> = Vec::new();
        // Pass 1: same type and name; when several candidates exist, the most similar pairs
        // go first (so two identically named components are not swapped), ties in document order.
        let mut cands: Vec<(usize, usize, usize)> = Vec::new(); // (cost, ib, ia)
        for &ib in &bc {
            for &ia in &ac {
                if compat(ib, ia) && b.comps[ib].name == a.comps[ia].name {
                    cands.push((similarity_cost(b, ib, a, ia), ib, ia));
                }
            }
        }
        cands.sort();
        for (_, ib, ia) in cands {
            if b2a[ib].is_none() && a2b[ia].is_none() {
                b2a[ib] = Some(ia);
                a2b[ia] = Some(ib);
                new_pairs.push((ib, ia));
            }
        }
        // Pass 2: rename heuristic, only when unambiguous.
        let mut elements: Vec<&str> = bc
            .iter()
            .filter(|i| b2a[**i].is_none())
            .map(|i| b.comps[*i].element.as_str())
            .collect();
        elements.sort();
        elements.dedup();
        for el in elements {
            let lb: Vec<usize> = bc
                .iter()
                .copied()
                .filter(|i| b2a[*i].is_none() && b.comps[*i].element == el)
                .collect();
            let la: Vec<usize> = ac
                .iter()
                .copied()
                .filter(|i| a2b[*i].is_none() && a.comps[*i].element == el)
                .collect();
            if lb.len() == 1 && la.len() == 1 && compat(lb[0], la[0]) {
                b2a[lb[0]] = Some(la[0]);
                a2b[la[0]] = Some(lb[0]);
                new_pairs.push((lb[0], la[0]));
            }
        }
        queue.extend(new_pairs);
    }
    Matching { b2a, a2b }
}

// ---------------------------------------------------------------------------------------------
// Param diffs
// ---------------------------------------------------------------------------------------------

fn dv(p: &ParamVal) -> DisplayValue {
    DisplayValue {
        raw: p.raw.clone(),
        display: p.display.clone(),
        unit: p.unit.clone(),
    }
}

fn plain_dv(text: &str) -> DisplayValue {
    DisplayValue {
        raw: text.to_string(),
        display: text.to_string(),
        unit: None,
    }
}

fn label_of(p: &ParamVal, doc: &Doc) -> String {
    match &p.cfg {
        Some(c) => format!("{} (configurazione «{}»)", p.label, doc.config_name(c)),
        None => p.label.clone(),
    }
}

fn diff_params(bp: &[ParamVal], ap: &[ParamVal], bd: &Doc, ad: &Doc) -> Vec<ParamChange> {
    let bmap: HashMap<String, &ParamVal> = bp.iter().map(|p| (p.full_key(), p)).collect();
    let amap: HashMap<String, &ParamVal> = ap.iter().map(|p| (p.full_key(), p)).collect();
    let mut out = Vec::new();
    for p in ap {
        let k = p.full_key();
        match bmap.get(&k) {
            Some(old) => {
                if old.cmp != p.cmp {
                    out.push(ParamChange {
                        key: k,
                        label: label_of(p, ad),
                        before: Some(dv(old)),
                        after: Some(dv(p)),
                    });
                }
            }
            None => {
                if !p.is_default {
                    out.push(ParamChange {
                        key: k,
                        label: label_of(p, ad),
                        before: None,
                        after: Some(dv(p)),
                    });
                }
            }
        }
    }
    for p in bp {
        let k = p.full_key();
        if !amap.contains_key(&k) && !p.is_default {
            out.push(ParamChange {
                key: k,
                label: label_of(p, bd),
                before: Some(dv(p)),
                after: None,
            });
        }
    }
    out
}

fn unk_diff(b: &[Unk], a: &[Unk]) -> (u32, Option<String>) {
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for u in a {
        *counts.entry(u.canon.as_str()).or_default() += 1;
    }
    for u in b {
        *counts.entry(u.canon.as_str()).or_default() -= 1;
    }
    let mut added = 0u32;
    let mut removed = 0u32;
    let mut sample: Option<String> = None;
    // Deterministic sample: first differing entry in document order (after first, then before).
    for u in a {
        let c = counts[u.canon.as_str()];
        if c > 0 && sample.is_none() {
            sample = Some(u.sample.clone());
        }
    }
    for u in b {
        let c = counts[u.canon.as_str()];
        if c < 0 && sample.is_none() {
            sample = Some(u.sample.clone());
        }
    }
    for c in counts.values() {
        if *c > 0 {
            added += *c as u32;
        } else if *c < 0 {
            removed += (-*c) as u32;
        }
    }
    (added.max(removed), sample)
}

#[derive(Default)]
struct UnkAgg {
    sections: Vec<(String, u32, Option<String>)>,
}

impl UnkAgg {
    fn add(&mut self, section: &str, count: u32, sample: Option<String>) {
        if count == 0 {
            return;
        }
        if let Some(s) = self.sections.iter_mut().find(|s| s.0 == section) {
            s.1 += count;
            if s.2.is_none() {
                s.2 = sample;
            }
        } else {
            self.sections.push((section.to_string(), count, sample));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Internal diff
// ---------------------------------------------------------------------------------------------

pub(crate) struct CompRec {
    pub b: Option<usize>,
    /// For added components: base index of the parent (if the parent exists in the base).
    pub parent_b: Option<usize>,
    pub change: ComponentChange,
}

pub(crate) struct CfgRec {
    pub id: String,
    pub change: ConfigChange,
}

pub(crate) struct SimRec {
    pub b_name: Option<String>,
    pub change: SimulationChange,
}

pub(crate) struct Internal {
    pub diff: OrkDiff,
    pub comps: Vec<CompRec>,
    /// Every base component with no counterpart after (roots and descendants).
    pub removed_all: HashSet<usize>,
    pub cfgs: Vec<CfgRec>,
    pub sims: Vec<SimRec>,
    pub unk_sections: Vec<(String, u32, Option<String>)>,
}

fn lis_keep(seq: &[usize]) -> HashSet<usize> {
    // Longest increasing subsequence over `seq` values; returns the indexes (into seq) kept.
    let n = seq.len();
    let mut best = vec![1usize; n];
    let mut prev = vec![usize::MAX; n];
    for i in 0..n {
        for j in 0..i {
            if seq[j] < seq[i] && best[j] + 1 > best[i] {
                best[i] = best[j] + 1;
                prev[i] = j;
            }
        }
    }
    let mut keep = HashSet::new();
    if n == 0 {
        return keep;
    }
    let mut end = 0;
    for i in 0..n {
        if best[i] > best[end] {
            end = i;
        }
    }
    let mut cur = end;
    loop {
        keep.insert(cur);
        if prev[cur] == usize::MAX {
            break;
        }
        cur = prev[cur];
    }
    keep
}

fn path_text(path: &[String]) -> String {
    if path.is_empty() {
        "Razzo".to_string()
    } else {
        path.join(" › ")
    }
}

pub(crate) fn compute(path: &str, b: &Doc, a: &Doc) -> Internal {
    let m = match_components(b, a);
    let mut agg = UnkAgg::default();
    let mut comps: Vec<CompRec> = Vec::new();

    // Reordering among siblings that stayed under the same parent.
    let mut reordered: HashSet<usize> = HashSet::new(); // `a` indexes
    for (pa, ac) in a.comps.iter().enumerate() {
        let stayed: Vec<(usize, usize)> = ac
            .children
            .iter()
            .filter_map(|&ia| {
                let ib = m.a2b[ia]?;
                let pb = b.comps[ib].parent?;
                if m.b2a[pb] == Some(pa) {
                    let pos = b.comps[pb].children.iter().position(|&c| c == ib)?;
                    Some((ia, pos))
                } else {
                    None
                }
            })
            .collect();
        let seq: Vec<usize> = stayed.iter().map(|(_, p)| *p).collect();
        let keep = lis_keep(&seq);
        for (i, (ia, _)) in stayed.iter().enumerate() {
            if !keep.contains(&i) {
                reordered.insert(*ia);
            }
        }
    }

    // Walk `a` in document order.
    let mut stack: Vec<usize> = vec![0];
    let mut order: Vec<usize> = Vec::new();
    while let Some(i) = stack.pop() {
        order.push(i);
        for c in a.comps[i].children.iter().rev() {
            stack.push(*c);
        }
    }
    for &ia in &order {
        let ca = &a.comps[ia];
        match m.a2b[ia] {
            None => {
                let parent_paired = ca.parent.map(|p| m.a2b[p].is_some()).unwrap_or(false);
                agg.add_unk_for_added(&ca.unknown, ca);
                if !parent_paired {
                    continue;
                }
                let mut params: Vec<ParamChange> = vec![ParamChange {
                    key: "name".into(),
                    label: "Nome".into(),
                    before: None,
                    after: Some(plain_dv(&ca.display_name())),
                }];
                params.extend(ca.params.iter().map(|p| ParamChange {
                    key: p.full_key(),
                    label: label_of(p, a),
                    before: None,
                    after: Some(dv(p)),
                }));
                let sub = a.descendants(ia);
                if sub > 0 {
                    params.push(sub_param(sub));
                }
                comps.push(CompRec {
                    b: None,
                    parent_b: ca.parent.and_then(|p| m.a2b[p]),
                    change: ComponentChange {
                        kind: ComponentChangeKind::Added,
                        component_type: ca.element.clone(),
                        type_label: ca.label.clone(),
                        name: ca.display_name(),
                        path: a.path_of(ia),
                        params,
                    },
                });
            }
            Some(ib) => {
                let cb = &b.comps[ib];
                let mut params: Vec<ParamChange> = Vec::new();
                if cb.name != ca.name {
                    params.push(ParamChange {
                        key: "name".into(),
                        label: "Nome".into(),
                        before: Some(plain_dv(&cb.display_name())),
                        after: Some(plain_dv(&ca.display_name())),
                    });
                }
                params.extend(diff_params(&cb.params, &ca.params, b, a));
                let (cnt, sample) = unk_diff(&cb.unknown, &ca.unknown);
                agg.add(
                    "Componenti",
                    cnt,
                    sample.map(|s| format!("{} «{}»: {}", ca.label, ca.display_name(), s)),
                );
                // Moved: different (matched) parent, or reordered among siblings.
                let parent_changed = match (cb.parent, ca.parent) {
                    (Some(pb), Some(pa)) => m.b2a[pb] != Some(pa),
                    _ => false,
                };
                let is_moved = parent_changed || reordered.contains(&ia);
                if is_moved {
                    let before_path = path_text(&b.path_of(ib));
                    let after_path = path_text(&a.path_of(ia));
                    if parent_changed {
                        params.insert(
                            0,
                            ParamChange {
                                key: "parent".into(),
                                label: "Contenuto in".into(),
                                before: Some(plain_dv(&before_path)),
                                after: Some(plain_dv(&after_path)),
                            },
                        );
                    } else {
                        let pos = |d: &Doc, i: usize| -> usize {
                            d.comps[i]
                                .parent
                                .map(|p| {
                                    d.comps[p]
                                        .children
                                        .iter()
                                        .position(|&c| c == i)
                                        .unwrap_or(0)
                                        + 1
                                })
                                .unwrap_or(1)
                        };
                        params.insert(
                            0,
                            ParamChange {
                                key: "order".into(),
                                label: "Posizione nell'elenco dei componenti".into(),
                                before: Some(plain_dv(&pos(b, ib).to_string())),
                                after: Some(plain_dv(&pos(a, ia).to_string())),
                            },
                        );
                    }
                }
                if is_moved || !params.is_empty() {
                    comps.push(CompRec {
                        b: Some(ib),
                        parent_b: None,
                        change: ComponentChange {
                            kind: if is_moved {
                                ComponentChangeKind::Moved
                            } else {
                                ComponentChangeKind::Modified
                            },
                            component_type: ca.element.clone(),
                            type_label: ca.label.clone(),
                            name: ca.display_name(),
                            path: a.path_of(ia),
                            params,
                        },
                    });
                }
            }
        }
    }
    // Removed components (roots of removed subtrees), in base document order.
    let mut removed_all = HashSet::new();
    let mut stack: Vec<usize> = vec![0];
    let mut border: Vec<usize> = Vec::new();
    while let Some(i) = stack.pop() {
        border.push(i);
        for c in b.comps[i].children.iter().rev() {
            stack.push(*c);
        }
    }
    for &ib in &border {
        if m.b2a[ib].is_some() {
            continue;
        }
        removed_all.insert(ib);
        let cb = &b.comps[ib];
        agg.add_unk_for_added(&cb.unknown, cb);
        let parent_paired = cb.parent.map(|p| m.b2a[p].is_some()).unwrap_or(false);
        if !parent_paired {
            continue;
        }
        let mut params: Vec<ParamChange> = vec![ParamChange {
            key: "name".into(),
            label: "Nome".into(),
            before: Some(plain_dv(&cb.display_name())),
            after: None,
        }];
        params.extend(cb.params.iter().map(|p| ParamChange {
            key: p.full_key(),
            label: label_of(p, b),
            before: Some(dv(p)),
            after: None,
        }));
        let sub = b.descendants(ib);
        if sub > 0 {
            let mut sp = sub_param(sub);
            sp.before = sp.after.take();
            params.push(sp);
        }
        comps.push(CompRec {
            b: Some(ib),
            parent_b: None,
            change: ComponentChange {
                kind: ComponentChangeKind::Removed,
                component_type: cb.element.clone(),
                type_label: cb.label.clone(),
                name: cb.display_name(),
                path: b.path_of(ib),
                params,
            },
        });
    }

    let cfgs = diff_configs(b, a, &m);
    let sims = diff_sims(b, a, &mut agg);

    // Document-level uninterpreted sections.
    let mut sections: Vec<String> = Vec::new();
    for mi in b.misc.iter().chain(a.misc.iter()) {
        if !sections.contains(&mi.section) {
            sections.push(mi.section.clone());
        }
    }
    for s in sections {
        let bi: Vec<Unk> = b
            .misc
            .iter()
            .filter(|x| x.section == s)
            .flat_map(|x| x.items.clone())
            .collect();
        let ai: Vec<Unk> = a
            .misc
            .iter()
            .filter(|x| x.section == s)
            .flat_map(|x| x.items.clone())
            .collect();
        let (c, sample) = unk_diff(&bi, &ai);
        agg.add(&s, c, sample);
    }
    // Attached files (decals, textures).
    {
        let bm: BTreeMap<&str, (u64, u32)> = b
            .attachments
            .iter()
            .map(|x| (x.name.as_str(), (x.size, x.crc32)))
            .collect();
        let am: BTreeMap<&str, (u64, u32)> = a
            .attachments
            .iter()
            .map(|x| (x.name.as_str(), (x.size, x.crc32)))
            .collect();
        let mut n = 0u32;
        let mut sample = None;
        for (k, v) in &am {
            if bm.get(k) != Some(v) {
                n += 1;
                sample.get_or_insert_with(|| (*k).to_string());
            }
        }
        for k in bm.keys() {
            if !am.contains_key(k) {
                n += 1;
                sample.get_or_insert_with(|| (*k).to_string());
            }
        }
        agg.add(
            "Immagini allegate al file (decalcomanie, texture)",
            n,
            sample,
        );
    }

    let uninterpreted: Vec<UninterpretedChange> = agg
        .sections
        .iter()
        .map(|(s, c, sample)| UninterpretedChange {
            section: s.clone(),
            count: *c,
            sample: sample.clone(),
        })
        .collect();

    let diff = OrkDiff {
        path: path.to_string(),
        before: Some(b.summary.clone()),
        after: Some(a.summary.clone()),
        components: comps.iter().map(|c| c.change.clone()).collect(),
        motor_configurations: cfgs.iter().map(|c| c.change.clone()).collect(),
        simulations: sims.iter().map(|s| s.change.clone()).collect(),
        uninterpreted,
        parse_error: None,
    };
    Internal {
        diff,
        comps,
        removed_all,
        cfgs,
        sims,
        unk_sections: agg.sections,
    }
}

impl UnkAgg {
    fn add_unk_for_added(&mut self, unk: &[Unk], c: &model::FlatComp) {
        if !unk.is_empty() {
            self.add(
                "Componenti",
                unk.len() as u32,
                Some(format!(
                    "{} «{}»: {}",
                    c.label,
                    c.display_name(),
                    unk[0].sample
                )),
            );
        }
    }
}

fn sub_param(n: usize) -> ParamChange {
    ParamChange {
        key: "subcomponents".into(),
        label: "Sottocomponenti".into(),
        before: None,
        after: Some(DisplayValue {
            raw: n.to_string(),
            display: if n == 1 {
                "1 componente".to_string()
            } else {
                format!("{n} componenti")
            },
            unit: None,
        }),
    }
}

// ---------------------------------------------------------------------------------------------
// Motor configurations
// ---------------------------------------------------------------------------------------------

fn ignition_text(m: &MotorUse) -> Option<String> {
    let ev = m.ignition_event.as_deref()?;
    let mut s = translate(units::IGNITION_EVENT, ev);
    if let Some(d) = &m.ignition_delay {
        s.push_str(&format!(", ritardo {}", render(Kind::Time, d).display));
    }
    Some(s)
}

fn motor_dv(m: &MotorUse, note_definition: bool) -> DisplayValue {
    let mut display = model::motor_display(m);
    if note_definition {
        display.push_str(" (definizione del motore diversa)");
    }
    DisplayValue {
        raw: format!(
            "{}|{}|{}|{}",
            m.manufacturer, m.designation, m.delay, m.definition
        ),
        display,
        unit: None,
    }
}

fn config_params(
    b: Option<(&Doc, &str)>,
    a: Option<(&Doc, &str)>,
    m: &Matching,
) -> Vec<ParamChange> {
    let mut out: Vec<ParamChange> = Vec::new();
    let name_of = |d: &Doc, i: usize| d.comps[i].display_name();
    let b_motors: Vec<&MotorUse> = b.map(|(d, id)| d.motors_of(id)).unwrap_or_default();
    let a_motors: Vec<&MotorUse> = a.map(|(d, id)| d.motors_of(id)).unwrap_or_default();

    if let (Some((bd, bid)), Some((ad, aid))) = (b, a) {
        let bn = bd
            .config(bid)
            .and_then(|c| c.name.clone())
            .unwrap_or_default();
        let an = ad
            .config(aid)
            .and_then(|c| c.name.clone())
            .unwrap_or_default();
        if bn != an {
            out.push(ParamChange {
                key: "name".into(),
                label: "Nome della configurazione".into(),
                before: Some(plain_dv(&bn)),
                after: Some(plain_dv(&an)),
            });
        }
    }
    // Stage activation: only deactivated stages are meaningful (all active is the default).
    let inactive = |d: Option<(&Doc, &str)>| -> Option<String> {
        let list: Vec<String> = d
            .and_then(|(doc, id)| doc.config(id))
            .map(|c| {
                c.stages
                    .iter()
                    .filter(|(_, act)| act != "true")
                    .map(|(n, _)| (n.parse::<i64>().unwrap_or(0) + 1).to_string())
                    .collect()
            })
            .unwrap_or_default();
        if list.is_empty() {
            None
        } else {
            Some(list.join(", "))
        }
    };
    let (bs, as_) = (inactive(b), inactive(a));
    if bs != as_ {
        out.push(ParamChange {
            key: "stages".into(),
            label: "Stadi disattivati".into(),
            before: Some(plain_dv(bs.as_deref().unwrap_or("nessuno"))),
            after: Some(plain_dv(as_.as_deref().unwrap_or("nessuno"))),
        });
    }

    // Motors, paired through the component matching.
    let mut used_b: HashSet<usize> = HashSet::new();
    for (ai, ma) in a_motors.iter().enumerate() {
        let b_mount = m.a2b[ma.mount];
        let bi = b_motors
            .iter()
            .enumerate()
            .find(|(i, mb)| Some(mb.mount) == b_mount && !used_b.contains(i))
            .map(|(i, _)| i);
        let a_name = a.map(|(d, _)| name_of(d, ma.mount)).unwrap_or_default();
        let key_base = match b_mount {
            Some(bm) => format!("b{bm}"),
            None => format!("a{}", ma.mount),
        };
        let _ = ai;
        match bi {
            Some(i) => {
                used_b.insert(i);
                let mb = b_motors[i];
                let same_text = model::motor_display(mb) == model::motor_display(ma);
                if !same_text || mb.definition != ma.definition {
                    out.push(ParamChange {
                        key: format!("motor@{key_base}"),
                        label: format!("Motore in «{a_name}»"),
                        before: Some(motor_dv(mb, false)),
                        after: Some(motor_dv(ma, same_text)),
                    });
                }
                let (ib, ia) = (ignition_text(mb), ignition_text(ma));
                if ib != ia {
                    out.push(ParamChange {
                        key: format!("ignition@{key_base}"),
                        label: format!("Accensione in «{a_name}»"),
                        before: ib.map(|s| plain_dv(&s)),
                        after: ia.map(|s| plain_dv(&s)),
                    });
                }
            }
            None => out.push(ParamChange {
                key: format!("motor@{key_base}"),
                label: format!("Motore in «{a_name}»"),
                before: None,
                after: Some(motor_dv(ma, false)),
            }),
        }
    }
    for (i, mb) in b_motors.iter().enumerate() {
        if used_b.contains(&i) {
            continue;
        }
        let b_name = b.map(|(d, _)| name_of(d, mb.mount)).unwrap_or_default();
        out.push(ParamChange {
            key: format!("motor@b{}", mb.mount),
            label: format!("Motore in «{b_name}»"),
            before: Some(motor_dv(mb, false)),
            after: None,
        });
    }
    out
}

fn diff_configs(b: &Doc, a: &Doc, m: &Matching) -> Vec<CfgRec> {
    let mut out = Vec::new();
    for ca in &a.configs {
        match b.config(&ca.id) {
            Some(_) => {
                let params = config_params(Some((b, &ca.id)), Some((a, &ca.id)), m);
                if !params.is_empty() {
                    out.push(CfgRec {
                        id: ca.id.clone(),
                        change: ConfigChange {
                            kind: ChangeKind::Modified,
                            name: a.config_name(&ca.id),
                            params,
                        },
                    });
                }
            }
            None => out.push(CfgRec {
                id: ca.id.clone(),
                change: ConfigChange {
                    kind: ChangeKind::Added,
                    name: a.config_name(&ca.id),
                    params: config_params(None, Some((a, &ca.id)), m),
                },
            }),
        }
    }
    for cb in &b.configs {
        if a.config(&cb.id).is_none() {
            out.push(CfgRec {
                id: cb.id.clone(),
                change: ConfigChange {
                    kind: ChangeKind::Removed,
                    name: b.config_name(&cb.id),
                    params: config_params(Some((b, &cb.id)), None, m),
                },
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------------------------

fn diff_sims(b: &Doc, a: &Doc, agg: &mut UnkAgg) -> Vec<SimRec> {
    let mut pairs: Vec<(usize, usize)> = Vec::new(); // (b, a)
    let mut used_b: HashSet<usize> = HashSet::new();
    let mut used_a: HashSet<usize> = HashSet::new();
    for (ia, sa) in a.sims.iter().enumerate() {
        if let Some((ib, _)) = b
            .sims
            .iter()
            .enumerate()
            .find(|(ib, sb)| !used_b.contains(ib) && sb.name == sa.name)
        {
            used_b.insert(ib);
            used_a.insert(ia);
            pairs.push((ib, ia));
        }
    }
    // Rename: exactly one leftover on each side with the same flight configuration.
    let lb: Vec<usize> = (0..b.sims.len()).filter(|i| !used_b.contains(i)).collect();
    let la: Vec<usize> = (0..a.sims.len()).filter(|i| !used_a.contains(i)).collect();
    if lb.len() == 1 && la.len() == 1 && b.sims[lb[0]].config_id == a.sims[la[0]].config_id {
        pairs.push((lb[0], la[0]));
        used_b.insert(lb[0]);
        used_a.insert(la[0]);
    }

    let mut out = Vec::new();
    for (ia, sa) in a.sims.iter().enumerate() {
        match pairs.iter().find(|(_, x)| *x == ia) {
            Some(&(ib, _)) => {
                let sb = &b.sims[ib];
                let mut conditions = diff_params(&sb.conditions, &sa.conditions, b, a);
                if sb.name != sa.name {
                    conditions.insert(
                        0,
                        ParamChange {
                            key: "name".into(),
                            label: "Nome".into(),
                            before: Some(plain_dv(&sb.name)),
                            after: Some(plain_dv(&sa.name)),
                        },
                    );
                }
                let results = diff_params(&sb.results, &sa.results, b, a);
                let data_updated = sb.flight_fp != sa.flight_fp;
                let (cnt, sample) = unk_diff(&sb.unknown, &sa.unknown);
                agg.add(
                    "Simulazioni",
                    cnt,
                    sample.map(|s| format!("«{}»: {}", sa.name, s)),
                );
                if !conditions.is_empty() || !results.is_empty() || data_updated {
                    out.push(SimRec {
                        b_name: Some(sb.name.clone()),
                        change: SimulationChange {
                            kind: ChangeKind::Modified,
                            name: sa.name.clone(),
                            conditions,
                            results,
                            data_updated,
                        },
                    });
                }
            }
            None => {
                if !sa.unknown.is_empty() {
                    agg.add(
                        "Simulazioni",
                        sa.unknown.len() as u32,
                        Some(format!("«{}»: {}", sa.name, sa.unknown[0].sample)),
                    );
                }
                out.push(SimRec {
                    b_name: None,
                    change: SimulationChange {
                        kind: ChangeKind::Added,
                        name: sa.name.clone(),
                        conditions: sa
                            .conditions
                            .iter()
                            .map(|p| ParamChange {
                                key: p.full_key(),
                                label: label_of(p, a),
                                before: None,
                                after: Some(dv(p)),
                            })
                            .collect(),
                        results: sa
                            .results
                            .iter()
                            .map(|p| ParamChange {
                                key: p.full_key(),
                                label: label_of(p, a),
                                before: None,
                                after: Some(dv(p)),
                            })
                            .collect(),
                        data_updated: false,
                    },
                });
            }
        }
    }
    for (ib, sb) in b.sims.iter().enumerate() {
        if used_b.contains(&ib) {
            continue;
        }
        if !sb.unknown.is_empty() {
            agg.add(
                "Simulazioni",
                sb.unknown.len() as u32,
                Some(format!("«{}»: {}", sb.name, sb.unknown[0].sample)),
            );
        }
        out.push(SimRec {
            b_name: Some(sb.name.clone()),
            change: SimulationChange {
                kind: ChangeKind::Removed,
                name: sb.name.clone(),
                conditions: Vec::new(),
                results: sb
                    .results
                    .iter()
                    .map(|p| ParamChange {
                        key: p.full_key(),
                        label: label_of(p, b),
                        before: Some(dv(p)),
                        after: None,
                    })
                    .collect(),
                data_updated: false,
            },
        });
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Three-way overlap
// ---------------------------------------------------------------------------------------------

fn marker(text: &str) -> DisplayValue {
    plain_dv(text)
}

fn param_map(params: &[ParamChange]) -> HashMap<&str, &ParamChange> {
    params.iter().map(|p| (p.key.as_str(), p)).collect()
}

fn overlap_params(
    path: &[String],
    name: &str,
    mine: &[ParamChange],
    theirs: &[ParamChange],
    out: &mut Vec<OverlapItem>,
) {
    let tm = param_map(theirs);
    for pm in mine {
        if pm.key == "subcomponents" {
            continue;
        }
        if let Some(pt) = tm.get(pm.key.as_str()) {
            let same = match (&pm.after, &pt.after) {
                (Some(x), Some(y)) => x.display == y.display && x.unit == y.unit,
                (None, None) => true,
                _ => false,
            };
            if !same {
                out.push(OverlapItem {
                    component_path: path.to_vec(),
                    component_name: name.to_string(),
                    key: Some(pm.key.clone()),
                    label: pm.label.clone(),
                    mine: pm.after.clone(),
                    theirs: pt.after.clone(),
                });
            }
        }
    }
}

pub(crate) fn overlaps(base: &Doc, mine: &Internal, theirs: &Internal) -> Vec<OverlapItem> {
    let mut out: Vec<OverlapItem> = Vec::new();
    let by_base = |i: &Internal| -> HashMap<usize, usize> {
        i.comps
            .iter()
            .enumerate()
            .filter_map(|(n, r)| r.b.map(|b| (b, n)))
            .collect()
    };
    let mb = by_base(mine);
    let tb = by_base(theirs);
    let mut bases: Vec<usize> = mb.keys().chain(tb.keys()).copied().collect();
    bases.sort();
    bases.dedup();
    for ib in bases {
        let path = base.path_of(ib);
        let name = base.comps[ib].display_name();
        let (rm, rt) = (
            mb.get(&ib).map(|n| &mine.comps[*n]),
            tb.get(&ib).map(|n| &theirs.comps[*n]),
        );
        match (rm, rt) {
            (Some(x), Some(y)) => {
                use ComponentChangeKind::*;
                match (x.change.kind, y.change.kind) {
                    (Removed, Removed) => {}
                    (Removed, _) => out.push(OverlapItem {
                        component_path: path,
                        component_name: name,
                        key: None,
                        label: "Rimosso da una parte, modificato dall'altra".into(),
                        mine: None,
                        theirs: Some(marker("modificato")),
                    }),
                    (_, Removed) => out.push(OverlapItem {
                        component_path: path,
                        component_name: name,
                        key: None,
                        label: "Modificato da una parte, rimosso dall'altra".into(),
                        mine: Some(marker("modificato")),
                        theirs: None,
                    }),
                    _ => overlap_params(&path, &name, &x.change.params, &y.change.params, &mut out),
                }
            }
            (Some(x), None) => {
                if theirs.removed_all.contains(&ib) && x.change.kind != ComponentChangeKind::Removed
                {
                    out.push(OverlapItem {
                        component_path: path,
                        component_name: name,
                        key: None,
                        label: "Modificato da una parte, rimosso dall'altra".into(),
                        mine: Some(marker("modificato")),
                        theirs: None,
                    });
                }
            }
            (None, Some(y)) => {
                if mine.removed_all.contains(&ib) && y.change.kind != ComponentChangeKind::Removed {
                    out.push(OverlapItem {
                        component_path: path,
                        component_name: name,
                        key: None,
                        label: "Rimosso da una parte, modificato dall'altra".into(),
                        mine: None,
                        theirs: Some(marker("modificato")),
                    });
                }
            }
            (None, None) => {}
        }
    }
    // Added components.
    fn added(i: &Internal) -> Vec<&CompRec> {
        i.comps
            .iter()
            .filter(|r| r.change.kind == ComponentChangeKind::Added)
            .collect()
    }
    let (am, at) = (added(mine), added(theirs));
    for x in &am {
        // Same component added by both under the same parent.
        if let Some(y) = at.iter().find(|y| {
            y.parent_b == x.parent_b
                && y.change.component_type == x.change.component_type
                && y.change.name == x.change.name
        }) {
            let _ = y;
            out.push(OverlapItem {
                component_path: x.change.path.clone(),
                component_name: x.change.name.clone(),
                key: None,
                label: "Aggiunto da entrambe le parti".into(),
                mine: Some(marker("aggiunto")),
                theirs: Some(marker("aggiunto")),
            });
        }
        // Added under a parent the other side removed.
        if let Some(p) = x.parent_b {
            if theirs.removed_all.contains(&p) {
                out.push(OverlapItem {
                    component_path: base.path_of(p),
                    component_name: base.comps[p].display_name(),
                    key: None,
                    label: format!(
                        "Aggiunto «{}» dentro un componente rimosso dall'altra parte",
                        x.change.name
                    ),
                    mine: Some(marker("aggiunto")),
                    theirs: None,
                });
            }
        }
    }
    for y in &at {
        if let Some(p) = y.parent_b {
            if mine.removed_all.contains(&p) {
                out.push(OverlapItem {
                    component_path: base.path_of(p),
                    component_name: base.comps[p].display_name(),
                    key: None,
                    label: format!(
                        "Aggiunto «{}» dentro un componente rimosso dall'altra parte",
                        y.change.name
                    ),
                    mine: None,
                    theirs: Some(marker("aggiunto")),
                });
            }
        }
    }

    // Motor configurations.
    let cfg_path = vec!["Configurazioni dei motori".to_string()];
    for x in &mine.cfgs {
        if let Some(y) = theirs.cfgs.iter().find(|y| y.id == x.id) {
            use ChangeKind::*;
            match (x.change.kind, y.change.kind) {
                (Removed, Removed) => {}
                (Removed, _) => out.push(OverlapItem {
                    component_path: cfg_path.clone(),
                    component_name: base.config_name(&x.id),
                    key: None,
                    label: "Rimossa da una parte, modificata dall'altra".into(),
                    mine: None,
                    theirs: Some(marker("modificata")),
                }),
                (_, Removed) => out.push(OverlapItem {
                    component_path: cfg_path.clone(),
                    component_name: base.config_name(&x.id),
                    key: None,
                    label: "Modificata da una parte, rimossa dall'altra".into(),
                    mine: Some(marker("modificata")),
                    theirs: None,
                }),
                _ => overlap_params(
                    &cfg_path,
                    &base.config_name(&x.id),
                    &x.change.params,
                    &y.change.params,
                    &mut out,
                ),
            }
        }
    }

    // Simulations.
    let sim_path = vec!["Simulazioni".to_string()];
    for x in &mine.sims {
        match (&x.b_name, x.change.kind) {
            (Some(bn), _) => {
                if let Some(y) = theirs.sims.iter().find(|y| y.b_name.as_deref() == Some(bn)) {
                    use ChangeKind::*;
                    match (x.change.kind, y.change.kind) {
                        (Removed, Removed) => {}
                        (Removed, _) => out.push(OverlapItem {
                            component_path: sim_path.clone(),
                            component_name: bn.clone(),
                            key: None,
                            label: "Rimossa da una parte, modificata dall'altra".into(),
                            mine: None,
                            theirs: Some(marker("modificata")),
                        }),
                        (_, Removed) => out.push(OverlapItem {
                            component_path: sim_path.clone(),
                            component_name: bn.clone(),
                            key: None,
                            label: "Modificata da una parte, rimossa dall'altra".into(),
                            mine: Some(marker("modificata")),
                            theirs: None,
                        }),
                        _ => {
                            let mut mine_p = x.change.conditions.clone();
                            mine_p.extend(x.change.results.clone());
                            let mut theirs_p = y.change.conditions.clone();
                            theirs_p.extend(y.change.results.clone());
                            overlap_params(&sim_path, bn, &mine_p, &theirs_p, &mut out);
                        }
                    }
                }
            }
            (None, _) => {
                if theirs
                    .sims
                    .iter()
                    .any(|y| y.b_name.is_none() && y.change.name == x.change.name)
                {
                    out.push(OverlapItem {
                        component_path: sim_path.clone(),
                        component_name: x.change.name.clone(),
                        key: None,
                        label: "Aggiunta da entrambe le parti".into(),
                        mine: Some(marker("aggiunta")),
                        theirs: Some(marker("aggiunta")),
                    });
                }
            }
        }
    }

    // Uninterpreted changes in the same section on both sides: cannot be proven independent.
    for (s, c, _) in &mine.unk_sections {
        if let Some((_, c2, _)) = theirs.unk_sections.iter().find(|(s2, _, _)| s2 == s) {
            out.push(OverlapItem {
                component_path: Vec::new(),
                component_name: s.clone(),
                key: None,
                label: "Modifiche non interpretate da entrambe le parti".into(),
                mine: Some(marker(&format!("{c} elementi modificati"))),
                theirs: Some(marker(&format!("{c2} elementi modificati"))),
            });
        }
    }
    out
}
