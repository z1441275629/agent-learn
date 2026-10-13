export type ToolImpl = (args: any) => Promise<string>
export type ToolDef = {
	description: string
	parameters: object
	impl: ToolImpl
	maxResultTokens?: number
}
