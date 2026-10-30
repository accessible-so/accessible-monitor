//! Stamps the outermost host element that each function component returns with
//! `data-a11y-component` and `data-a11y-source`, so a barrier the collector
//! finds in a real session can be attributed back to the component that
//! rendered it.
//!
//! The transform is purely syntactic — it never resolves imports or types, so
//! server components get exactly the same treatment as client ones.
//!
//! Deliberate non-goals, each of which keeps the output honest:
//!
//! * **Host elements only.** A composite (`<Layout>`, `<Foo.Bar>`) is left
//!   alone: its own definition is stamped when that file compiles, and an
//!   unknown prop on an arbitrary component can reach the DOM through a spread
//!   — or be dropped entirely — so stamping it would be a guess.
//! * **Fragments are left alone.** There is no element to carry the attribute.
//! * **Already-stamped elements are left alone**, so a hand-written stamp and
//!   an inner component's stamp both win over an enclosing one.
//! * **No fake line numbers.** If the host cannot resolve a line for a span,
//!   the source value is the file alone rather than a made-up `:0`.

use swc_core::common::{Span, DUMMY_SP};
use swc_core::ecma::ast::*;
use swc_core::ecma::atoms::Atom;
use swc_core::ecma::visit::{VisitMut, VisitMutWith};
use swc_core::plugin::{
    metadata::TransformPluginMetadataContextKind, plugin_transform,
    proxies::TransformPluginProgramMetadata,
};

/// The `data-a11y-component` attribute name.
pub const COMPONENT_ATTR: &str = "data-a11y-component";
/// The `data-a11y-source` attribute name.
pub const SOURCE_ATTR: &str = "data-a11y-source";

/// The beacon's attribute policy caps a stamped value at 64 characters. Stay
/// under it with room to spare by dropping the parent directory from
/// `data-a11y-source` once the two-segment form would pass this length.
const MAX_SOURCE_LEN: usize = 60;

/// Resolves the 1-based line for a span, or `None` when the host cannot.
///
/// A boxed closure rather than a `&dyn SourceMapper`: the plugin's source map
/// arrives by value as a `PluginSourceMapProxy` while the fixture harness hands
/// out an `Lrc<SourceMap>`, and only `SourceMap` itself implements
/// `SourceMapper`. Closing over whichever one we have keeps `Stamper` free of
/// borrows, which the fixture harness requires (its transform factory must
/// return a type that outlives the `&mut Tester` it is given).
pub type LineResolver = Box<dyn Fn(Span) -> Option<usize>>;

/// The visitor. Construct with [`Stamper::new`].
pub struct Stamper {
    /// Already reduced to at most `<parent dir>/<file>` by [`short_path`].
    file: String,
    line_of: LineResolver,
}

/// True for a name React would treat as a component rather than a host tag.
fn is_component_name(name: &str) -> bool {
    name.chars()
        .next()
        .map(|c| c.is_ascii_uppercase())
        .unwrap_or(false)
}

/// True for a JSX tag React would render as a DOM element rather than a
/// component: a bare identifier starting with a lowercase ASCII letter.
fn is_host_tag(name: &JSXElementName) -> bool {
    match name {
        JSXElementName::Ident(id) => id
            .sym
            .chars()
            .next()
            .map(|c| c.is_ascii_lowercase())
            .unwrap_or(false),
        // `<Foo.Bar>` and `<svg:circle>` are never plain host elements here.
        _ => false,
    }
}

/// True when the path runs through a `node_modules` directory. A segment test
/// rather than a substring one, so a project checked out under, say,
/// `~/work/node_modules-migration/` is not silently skipped in its entirety.
pub fn is_dependency(file: &str) -> bool {
    file.split(['/', '\\']).any(|seg| seg == "node_modules")
}

/// Reduce a path to `<parent dir>/<file>`, handling both separators so a
/// Windows build stamps the same value a POSIX one does.
///
/// The parent directory is only kept when it is plausibly a *project*
/// directory. On an absolute path with fewer than three directories above the
/// file, the parent is a top-level or home directory — `/Users/<name>/page.tsx`
/// would stamp the account name, and `data-a11y-source` is documented as
/// carrying nothing but a repo-relative fragment. There the file name alone is
/// stamped. Relative paths always come from the compiler as a project-relative
/// form already, so they keep both segments.
pub fn short_path(file: &str) -> String {
    let parts: Vec<&str> = file
        .split(['/', '\\'])
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    match parts.len() {
        0 => String::new(),
        1 => parts[0].to_string(),
        n if is_rooted(file) && depth_below_root(&parts) < 4 => parts[n - 1].to_string(),
        n => format!("{}/{}", parts[n - 2], parts[n - 1]),
    }
}

/// True for a path anchored at a filesystem root: `/app/page.tsx`,
/// `\\server\share\page.tsx`, `C:\repo\page.tsx`.
fn is_rooted(file: &str) -> bool {
    file.starts_with('/') || file.starts_with('\\') || drive_letter(file)
}

/// `C:` / `c:` at the head of a Windows path.
fn drive_letter(file: &str) -> bool {
    let mut chars = file.chars();
    matches!((chars.next(), chars.next()), (Some(c), Some(':')) if c.is_ascii_alphabetic())
}

/// How many segments sit below the root, ignoring a drive letter so a Windows
/// path is measured the same way a POSIX one is.
fn depth_below_root(parts: &[&str]) -> usize {
    match parts.first() {
        Some(first) if drive_letter(first) && first.len() == 2 => parts.len() - 1,
        _ => parts.len(),
    }
}

impl Stamper {
    pub fn new(file: String, line_of: LineResolver) -> Self {
        Self { file, line_of }
    }

    /// The single place a span is handed to the resolver, so the guard cannot
    /// be forgotten at a call site.
    ///
    /// Every source-map lookup available to a plugin panics on a miss:
    /// `SourceMapper::lookup_char_pos` is `try_lookup_char_pos(pos).unwrap()`
    /// in swc_common, and the plugin-side proxy adds its own `expect`s on top.
    /// The release profile aborts on panic, so a miss would not surface as a
    /// failed transform — it would trap the wasm and take the user's whole
    /// `next build` down, in a plugin whose entire premise is that everything
    /// works without it. So spans that a source map cannot be expected to
    /// cover never reach the lookup: a dummy span (an identifier synthesised
    /// by an earlier plugin, or by us) and an empty span carry no position to
    /// find. The result is simply no line, which `source_value` already knows
    /// how to render honestly.
    fn line_for(&self, span: Span) -> Option<usize> {
        if span.is_dummy() || span.lo >= span.hi {
            return None;
        }
        (self.line_of)(span)
    }

    /// `<parent dir>/<file>:<line>`, falling back to `<file>:<line>` when that
    /// would run past the beacon's attribute cap, and to `None` when there is
    /// no path to report at all — `":42"` is a broken value, not an absent one.
    fn source_value(&self, span: Span) -> Option<String> {
        if self.file.is_empty() {
            return None;
        }
        let line = self.line_for(span);
        let render = |path: &str| match line {
            Some(l) => format!("{path}:{l}"),
            None => path.to_string(),
        };
        let full = render(&self.file);
        // Count characters, not bytes: a non-ASCII path would otherwise fall
        // back to the bare filename earlier than intended. That errs short, so
        // it can never overflow the beacon's cap.
        if full.chars().count() <= MAX_SOURCE_LEN {
            return Some(full);
        }
        let base = self.file.rsplit('/').next().unwrap_or(&self.file);
        let short = render(base);
        // A file name can be long enough on its own to blow the cap. The
        // element attribute would be truncated to 64 characters by the beacon's
        // redactor while `comp.source` (read from the raw attribute, capped at
        // 256 on the wire) kept the full string, so the same element would
        // report two different sources. No attribution beats a broken path.
        if short.chars().count() <= MAX_SOURCE_LEN {
            return Some(short);
        }
        None
    }

    fn attr(name: &str, value: String) -> JSXAttrOrSpread {
        JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(IdentName::new(Atom::from(name), DUMMY_SP)),
            value: Some(JSXAttrValue::Str(Str {
                span: DUMMY_SP,
                value: Atom::from(value).into(),
                raw: None,
            })),
        })
    }

    /// True if either attribute is already present. Keying on both matters:
    /// a hand-written `data-a11y-source` would otherwise get a second one
    /// pushed beside it, and React keeps the last — silently replacing the
    /// author's value with ours.
    fn is_stamped(el: &JSXElement) -> bool {
        el.opening.attrs.iter().any(|a| {
            matches!(
                a,
                JSXAttrOrSpread::JSXAttr(JSXAttr {
                    name: JSXAttrName::Ident(n),
                    ..
                }) if &*n.sym == COMPONENT_ATTR || &*n.sym == SOURCE_ATTR
            )
        })
    }

    fn stamp_element(&self, el: &mut JSXElement, component: &str, span: Span) {
        if !is_host_tag(&el.opening.name) || Self::is_stamped(el) {
            return;
        }
        el.opening
            .attrs
            .push(Self::attr(COMPONENT_ATTR, component.to_string()));
        if let Some(source) = self.source_value(span) {
            el.opening.attrs.push(Self::attr(SOURCE_ATTR, source));
        }
    }

    /// Only the outermost returned element is a candidate; parentheses and a
    /// trailing `as`/`!` are transparent, everything else stops the walk.
    fn stamp_expr(&self, expr: &mut Expr, component: &str, span: Span) {
        match expr {
            Expr::Paren(p) => self.stamp_expr(&mut p.expr, component, span),
            Expr::TsAs(e) => self.stamp_expr(&mut e.expr, component, span),
            Expr::TsNonNull(e) => self.stamp_expr(&mut e.expr, component, span),
            Expr::TsSatisfies(e) => self.stamp_expr(&mut e.expr, component, span),
            Expr::JSXElement(el) => self.stamp_element(el, component, span),
            _ => {}
        }
    }

    /// Top-level `return` statements only. A `return` nested inside a branch or
    /// a callback is not reliably "the component's element", and walking into
    /// them would stamp helper closures with their enclosing component's name.
    fn stamp_body(&self, body: &mut FunctionBody, component: &str, span: Span) {
        for stmt in body.stmts.iter_mut() {
            if let Stmt::Return(ReturnStmt { arg: Some(arg), .. }) = stmt {
                self.stamp_expr(arg, component, span);
            }
        }
    }

    fn stamp_function(&self, function: &mut Function, component: &str, span: Span) {
        if let Some(body) = &mut function.body {
            self.stamp_body(body, component, span);
        }
    }
}

impl VisitMut for Stamper {
    /// `function ProductCard() {}`, including `export function ProductCard() {}`.
    fn visit_mut_fn_decl(&mut self, n: &mut FnDecl) {
        n.visit_mut_children_with(self);
        let name = n.ident.sym.to_string();
        if !is_component_name(&name) {
            return;
        }
        let span = n.ident.span;
        self.stamp_function(&mut n.function, &name, span);
    }

    /// `export default function Page() {}` — the App Router's own shape, which
    /// parses as a named function *expression*, not a declaration.
    ///
    /// Matched here, at the export, rather than on every `FnExpr`: a
    /// PascalCase name on a function expression is not by itself evidence of a
    /// component. `const handler = function Render() {}` and
    /// `rows.map(function Row() {…})` are both named function expressions and
    /// neither is a component, so stamping them would attribute an element to
    /// something that does not render one. A function expression bound to a
    /// PascalCase name is still stamped — under the binding's name, by
    /// `visit_mut_var_declarator` below.
    ///
    /// `export default function () {}` and `export default () => …` are
    /// skipped: there is no name to attribute to, and inventing one from the
    /// file name would be a guess.
    fn visit_mut_export_default_decl(&mut self, n: &mut ExportDefaultDecl) {
        n.visit_mut_children_with(self);
        let DefaultDecl::Fn(fn_expr) = &mut n.decl else {
            return;
        };
        let Some(ident) = &fn_expr.ident else { return };
        let name = ident.sym.to_string();
        if !is_component_name(&name) {
            return;
        }
        let span = ident.span;
        self.stamp_function(&mut fn_expr.function, &name, span);
    }

    /// `const Price = ({ v }) => <span>{v}</span>` and `const P = function () {}`.
    fn visit_mut_var_declarator(&mut self, n: &mut VarDeclarator) {
        n.visit_mut_children_with(self);
        let Pat::Ident(BindingIdent { id, .. }) = &n.name else {
            return;
        };
        let name = id.sym.to_string();
        if !is_component_name(&name) {
            return;
        }
        let span = id.span;
        match n.init.as_deref_mut() {
            Some(Expr::Arrow(arrow)) => match &mut *arrow.body {
                ArrowFunctionBody::FunctionBody(b) => self.stamp_body(b, &name, span),
                ArrowFunctionBody::Expr(e) => self.stamp_expr(e, &name, span),
            },
            // `const Price = function () {}`, and `const Price = function
            // Whatever() {}` too: the binding is what the rest of the module
            // renders, so the binding's name is the honest attribution.
            Some(Expr::Fn(f)) => self.stamp_function(&mut f.function, &name, span),
            _ => {}
        }
    }
}

#[plugin_transform]
pub fn process_transform(
    mut program: Program,
    metadata: TransformPluginProgramMetadata,
) -> Program {
    let filename = metadata
        .get_context(&TransformPluginMetadataContextKind::Filename)
        .unwrap_or_default();
    // Never rewrite dependencies: their components are not the user's to fix,
    // and the bundle cost would be paid on every vendored element.
    if is_dependency(&filename) {
        return program;
    }
    let source_map = metadata.source_map.clone();
    let mut stamper = Stamper::new(
        short_path(&filename),
        // Only reached for spans `Stamper::line_for` has already vetted; the
        // proxy has no non-panicking variant to call instead.
        Box::new(move |span: Span| {
            use swc_core::common::SourceMapper;
            Some(source_map.lookup_char_pos(span.lo).line)
        }),
    );
    program.visit_mut_with(&mut stamper);
    program
}

#[cfg(test)]
mod tests {
    use super::*;
    use swc_core::common::BytePos;

    /// A span the way the parser produces them: real, non-empty positions.
    fn real_span() -> Span {
        Span::new(BytePos(10), BytePos(20))
    }

    /// A resolver that must never be called. Reaching it in the tests below
    /// would mean an unguarded span had been handed to a source-map lookup —
    /// exactly the path that aborts the wasm in production.
    fn forbidden() -> LineResolver {
        Box::new(|_| panic!("the source map was consulted for a span it cannot cover"))
    }

    #[test]
    fn short_path_keeps_the_last_two_segments() {
        assert_eq!(short_path("/a/b/app/page.tsx"), "app/page.tsx");
        assert_eq!(short_path("./src/ui/Card.tsx"), "ui/Card.tsx");
        assert_eq!(short_path("page.tsx"), "page.tsx");
        assert_eq!(short_path(""), "");
    }

    #[test]
    fn short_path_handles_windows_separators() {
        assert_eq!(short_path(r"C:\a\repo\app\page.tsx"), "app/page.tsx");
        assert_eq!(short_path(r"app\page.tsx"), "app/page.tsx");
    }

    /// The one way `data-a11y-source` could carry something that is not a
    /// repo-relative fragment: a file sitting directly in a home directory,
    /// whose parent segment is the account name.
    #[test]
    fn short_path_never_stamps_a_home_directory_name() {
        assert_eq!(short_path("/Users/somebody/page.tsx"), "page.tsx");
        assert_eq!(short_path("/home/somebody/page.tsx"), "page.tsx");
        assert_eq!(short_path(r"C:\Users\somebody\page.tsx"), "page.tsx");
        assert_eq!(short_path("/repo/page.tsx"), "page.tsx");
        // A real checkout nests deeper, and keeps its parent directory.
        assert_eq!(
            short_path("/Users/somebody/work/shop/app/page.tsx"),
            "app/page.tsx"
        );
        // A relative path is already project-relative; nothing to strip.
        assert_eq!(short_path("app/page.tsx"), "app/page.tsx");
    }

    #[test]
    fn is_dependency_matches_a_whole_segment_only() {
        assert!(is_dependency("/repo/node_modules/next/dist/x.js"));
        assert!(is_dependency(r"C:\repo\node_modules\next\x.js"));
        // A project directory that merely contains the word must still be
        // instrumented, rather than silently losing attribution wholesale.
        assert!(!is_dependency("/work/node_modules-migration/app/page.tsx"));
        assert!(!is_dependency("/work/app/node_modules_notes.tsx"));
    }

    /// A file name that blows the cap on its own has no honest short form, so
    /// there is nothing to stamp — a truncated path would disagree with the
    /// `comp.source` the beacon carries for the very same element.
    #[test]
    fn source_value_is_absent_when_even_the_file_name_runs_long() {
        let long_name = format!("{}.tsx", "a".repeat(MAX_SOURCE_LEN));
        let s = Stamper::new(format!("app/{long_name}"), Box::new(|_| Some(12)));
        assert_eq!(s.source_value(real_span()), None);
    }

    #[test]
    fn source_value_drops_the_directory_when_it_would_run_long() {
        let long = "a-very-long-directory-name-that-just-keeps-on-going/page.tsx".to_string();
        let s = Stamper::new(long, Box::new(|_| Some(1234)));
        assert_eq!(s.source_value(real_span()).as_deref(), Some("page.tsx:1234"));

        let short = "app/page.tsx".to_string();
        let s = Stamper::new(short, Box::new(|_| Some(12)));
        assert_eq!(
            s.source_value(real_span()).as_deref(),
            Some("app/page.tsx:12")
        );
    }

    #[test]
    fn a_dummy_span_never_reaches_the_source_map() {
        let s = Stamper::new("app/page.tsx".to_string(), forbidden());
        assert_eq!(s.line_for(DUMMY_SP), None);
        assert_eq!(s.source_value(DUMMY_SP).as_deref(), Some("app/page.tsx"));
    }

    #[test]
    fn an_empty_span_never_reaches_the_source_map() {
        let empty = Span::new(BytePos(42), BytePos(42));
        let s = Stamper::new("app/page.tsx".to_string(), forbidden());
        assert_eq!(s.line_for(empty), None);
        assert_eq!(s.source_value(empty).as_deref(), Some("app/page.tsx"));
    }

    #[test]
    fn a_source_map_miss_yields_the_file_alone() {
        let s = Stamper::new("app/page.tsx".to_string(), Box::new(|_| None));
        assert_eq!(s.line_for(real_span()), None);
        assert_eq!(s.source_value(real_span()).as_deref(), Some("app/page.tsx"));
    }

    #[test]
    fn no_filename_means_no_source_attribute_at_all() {
        let s = Stamper::new(String::new(), Box::new(|_| Some(42)));
        assert_eq!(s.source_value(real_span()), None);
    }

    fn host_element(tag: &str, attrs: Vec<JSXAttrOrSpread>) -> JSXElement {
        JSXElement {
            span: DUMMY_SP,
            opening: JSXOpeningElement {
                name: JSXElementName::Ident(Ident::new_no_ctxt(Atom::from(tag), DUMMY_SP)),
                span: DUMMY_SP,
                attrs,
                self_closing: true,
                type_args: None,
            },
            children: vec![],
            closing: None,
        }
    }

    fn attr_pairs(el: &JSXElement) -> Vec<(String, String)> {
        el.opening
            .attrs
            .iter()
            .filter_map(|a| match a {
                JSXAttrOrSpread::JSXAttr(JSXAttr {
                    name: JSXAttrName::Ident(n),
                    value: Some(JSXAttrValue::Str(v)),
                    ..
                // `Str::value` is a `Wtf8Atom` as of swc_ecma_ast 25 and has no
                // `Display`. Everything this reads back was stamped by `attr`
                // from a component name or a source path, so the lossy
                // conversion is exact for every value that can reach here.
                }) => Some((n.sym.to_string(), v.value.to_atom_lossy().to_string())),
                _ => None,
            })
            .collect()
    }

    /// The whole no-line path, end to end: a component identifier synthesised
    /// by some earlier plugin carries `DUMMY_SP`, and the element still gets
    /// stamped — with the file alone, and without touching the source map.
    #[test]
    fn a_component_with_a_synthesised_ident_is_stamped_without_a_line() {
        let s = Stamper::new("app/page.tsx".to_string(), forbidden());
        let mut el = host_element("div", vec![]);
        s.stamp_element(&mut el, "Page", DUMMY_SP);
        assert_eq!(
            attr_pairs(&el),
            vec![
                ("data-a11y-component".to_string(), "Page".to_string()),
                ("data-a11y-source".to_string(), "app/page.tsx".to_string()),
            ]
        );
    }

    /// `return (<b/>)!;` — the third TypeScript-transparent wrapper in
    /// `stamp_expr`, alongside `as` and `satisfies`.
    ///
    /// A unit test rather than a fixture: swc's printer drops the parentheses
    /// around a non-null-asserted JSX element, and swc's parser then refuses to
    /// read `<b/>!` back, so a `!` case cannot round-trip through the fixture
    /// harness at all. The shape it builds is exactly what the parser produces
    /// for that source.
    #[test]
    fn a_non_null_assertion_on_a_returned_element_is_transparent() {
        let s = Stamper::new("app/price.tsx".to_string(), Box::new(|_| Some(9)));
        let mut expr = Expr::TsNonNull(TsNonNullExpr {
            span: DUMMY_SP,
            expr: Box::new(Expr::Paren(ParenExpr {
                span: DUMMY_SP,
                expr: Box::new(Expr::JSXElement(Box::new(host_element("b", vec![])))),
            })),
        });

        s.stamp_expr(&mut expr, "Price", real_span());

        let stamped = match &expr {
            Expr::TsNonNull(e) => match &*e.expr {
                Expr::Paren(p) => match &*p.expr {
                    Expr::JSXElement(el) => attr_pairs(el),
                    _ => panic!("the element was replaced, not stamped"),
                },
                _ => panic!("the parens were replaced, not walked through"),
            },
            _ => panic!("the assertion was replaced, not walked through"),
        };
        assert_eq!(
            stamped,
            vec![
                ("data-a11y-component".to_string(), "Price".to_string()),
                ("data-a11y-source".to_string(), "app/price.tsx:9".to_string()),
            ]
        );
    }

    /// A hand-written `data-a11y-source` is not joined by a second one — React
    /// keeps the last, so pushing ours would silently replace the author's.
    #[test]
    fn an_existing_source_attribute_blocks_the_stamp() {
        let s = Stamper::new("app/page.tsx".to_string(), Box::new(|_| Some(7)));
        let mut el = host_element(
            "div",
            vec![Stamper::attr(SOURCE_ATTR, "mine.tsx:1".to_string())],
        );
        s.stamp_element(&mut el, "Page", real_span());
        assert_eq!(
            attr_pairs(&el),
            vec![("data-a11y-source".to_string(), "mine.tsx:1".to_string())]
        );
    }
}
