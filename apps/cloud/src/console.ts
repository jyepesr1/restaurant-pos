import { createInterface } from 'node:readline'

// Ask for a secret in the terminal without showing it (the connection string, the admin token):
// that way it stays out of the terminal history and off the screen.

export function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput
    ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      // Only the question is shown; what is typed is not.
      if (s.includes(question)) write.call(rl, s)
    }
    rl.question(question, (response) => {
      rl.close()
      process.stdout.write('\n')
      resolve(response.trim())
    })
  })
}

/** An environment variable or, if it is not set, ask for it without showing it. */
export async function secret(variable: string, question: string): Promise<string> {
  const value = process.env[variable]?.trim() || (await askSecret(question))
  if (!value) {
    console.error('No escribiste nada. No se hizo ningún cambio.')
    process.exit(1)
  }
  return value
}
