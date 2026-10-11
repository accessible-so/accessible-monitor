interface Props {
  title: string;
}

export function Heading({ title }: Props) {
  return <h1 className="title">{title}</h1>;
}
