interface Props {
    title: string;
}
export function Heading({ title }: Props) {
    return <h1 className="title" data-a11y-component="Heading" data-a11y-source="fixture/input.tsx:5">{title}</h1>;
}
